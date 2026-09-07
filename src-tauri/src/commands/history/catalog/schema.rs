use super::super::*;
use super::{HISTORY_INDEX_MODEL_VERSION, HISTORY_INDEX_SCHEMA_VERSION};
use sqlx::{Connection, Row, SqliteConnection};

pub(super) async fn ensure_schema(conn: &mut SqliteConnection) -> Result<(), String> {
    let current_version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    if current_version >= HISTORY_INDEX_SCHEMA_VERSION {
        if !compact_fts_schema_ready(conn).await? {
            rebuild_compact_fts(conn).await?;
        }
        return Ok(());
    }
    let statements = [
        "CREATE TABLE IF NOT EXISTS history_catalog_sessions (
            roots_key TEXT NOT NULL,
            file_path TEXT NOT NULL,
            source TEXT NOT NULL,
            project_key TEXT NOT NULL,
            cwd TEXT,
            cwd_normalized TEXT,
            session_id TEXT NOT NULL,
            title TEXT NOT NULL,
            branch TEXT,
            parent_session_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            message_count INTEGER NOT NULL,
            file_created_at INTEGER NOT NULL,
            file_updated_at INTEGER NOT NULL,
            file_size INTEGER NOT NULL,
            parser_version INTEGER NOT NULL,
            indexed_at INTEGER NOT NULL,
            PRIMARY KEY (roots_key, file_path)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_catalog_sessions_scope
            ON history_catalog_sessions(roots_key, source, updated_at DESC, file_path)",
        "CREATE INDEX IF NOT EXISTS idx_history_catalog_sessions_project
            ON history_catalog_sessions(roots_key, cwd_normalized, source, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_history_catalog_sessions_identity
            ON history_catalog_sessions(roots_key, source, session_id)",
        "CREATE TABLE IF NOT EXISTS history_catalog_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            roots_key TEXT NOT NULL,
            file_path TEXT NOT NULL,
            message_index INTEGER NOT NULL,
            role TEXT NOT NULL,
            timestamp TEXT,
            content TEXT NOT NULL,
            UNIQUE (roots_key, file_path, message_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_catalog_messages_file
            ON history_catalog_messages(roots_key, file_path, message_index)",
        "CREATE VIRTUAL TABLE IF NOT EXISTS history_catalog_messages_fts USING fts5(
            content,
            content='history_catalog_messages',
            content_rowid='id',
            detail='none',
            tokenize='trigram case_sensitive 0'
        )",
        "CREATE TRIGGER IF NOT EXISTS history_catalog_messages_ai AFTER INSERT ON history_catalog_messages BEGIN
            INSERT INTO history_catalog_messages_fts(rowid, content) VALUES (new.id, new.content);
        END",
        "CREATE TRIGGER IF NOT EXISTS history_catalog_messages_ad AFTER DELETE ON history_catalog_messages BEGIN
            INSERT INTO history_catalog_messages_fts(history_catalog_messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
        END",
        "CREATE TRIGGER IF NOT EXISTS history_catalog_messages_au AFTER UPDATE ON history_catalog_messages BEGIN
            INSERT INTO history_catalog_messages_fts(history_catalog_messages_fts, rowid, content)
            VALUES ('delete', old.id, old.content);
            INSERT INTO history_catalog_messages_fts(rowid, content) VALUES (new.id, new.content);
        END",
        "CREATE TABLE IF NOT EXISTS history_catalog_state (
            roots_key TEXT PRIMARY KEY,
            phase TEXT NOT NULL,
            indexed_files INTEGER NOT NULL DEFAULT 0,
            total_files INTEGER NOT NULL DEFAULT 0,
            generation INTEGER NOT NULL DEFAULT 0,
            last_completed_at INTEGER,
            error TEXT,
            updated_at INTEGER NOT NULL
        )",
    ];
    for statement in statements {
        sqlx::query(statement)
            .execute(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
    }
    ensure_v2_schema(conn, current_version).await?;
    Ok(())
}

pub(super) async fn compact_fts_schema_ready(conn: &mut SqliteConnection) -> Result<bool, String> {
    for table in ["history_catalog_messages_fts", "history_messages_fts"] {
        let sql: Option<String> =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1")
                .bind(table)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| err.to_string())?;
        if !sql
            .map(|value| value.to_ascii_lowercase().contains("detail='none'"))
            .unwrap_or(false)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) async fn ensure_v2_schema(
    conn: &mut SqliteConnection,
    current_version: i64,
) -> Result<(), String> {
    let statements = [
        "CREATE TABLE IF NOT EXISTS history_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        "CREATE TABLE IF NOT EXISTS history_source_instances (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            environment_kind TEXT NOT NULL,
            environment_key TEXT NOT NULL,
            storage_kind TEXT NOT NULL,
            display_name TEXT,
            locations_json TEXT NOT NULL,
            settings_hash TEXT NOT NULL,
            activation_state TEXT NOT NULL DEFAULT 'pending',
            scope_kind TEXT NOT NULL DEFAULT 'configured',
            scope_key TEXT NOT NULL DEFAULT 'desktop',
            transport_kind TEXT NOT NULL DEFAULT 'local',
            materialization_level TEXT NOT NULL DEFAULT 'full',
            freshness_state TEXT NOT NULL DEFAULT 'fresh',
            as_of INTEGER,
            remote_identity_json TEXT,
            sync_cursor_json TEXT,
            discovered INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_source_instances_source
            ON history_source_instances(source_id, activation_state)",
        "CREATE TABLE IF NOT EXISTS history_sessions (
            id INTEGER PRIMARY KEY,
            source_instance_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            storage_kind TEXT NOT NULL,
            primary_path TEXT,
            database_path TEXT,
            raw_key TEXT,
            source_version TEXT,
            project_key TEXT,
            cwd TEXT,
            cwd_normalized TEXT,
            title TEXT NOT NULL,
            branch TEXT,
            parent_session_id TEXT,
            lifecycle_state TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            timestamp_quality TEXT NOT NULL DEFAULT 'reported',
            message_count INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd REAL NOT NULL DEFAULT 0,
            usage_quality TEXT NOT NULL DEFAULT 'unknown',
            cost_kind TEXT NOT NULL DEFAULT 'unknown',
            pricing_version TEXT,
            dominant_model TEXT,
            current_model TEXT,
            context_window INTEGER,
            last_context_tokens INTEGER,
            reasoning_effort TEXT,
            tool_call_count INTEGER NOT NULL DEFAULT 0,
            fingerprint_kind TEXT NOT NULL,
            fingerprint_value TEXT NOT NULL,
            parser_version INTEGER NOT NULL,
            model_version INTEGER NOT NULL,
            parse_status TEXT NOT NULL,
            materialization_level TEXT NOT NULL DEFAULT 'full',
            freshness_state TEXT NOT NULL DEFAULT 'fresh',
            as_of INTEGER,
            tombstoned_at INTEGER,
            completeness_json TEXT,
            raw_pointers_json TEXT,
            source_extension_json TEXT,
            last_seen_generation INTEGER NOT NULL,
            indexed_at INTEGER NOT NULL,
            FOREIGN KEY(source_instance_id)
                REFERENCES history_source_instances(id) ON DELETE CASCADE,
            UNIQUE(source_instance_id, source_session_id)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_sessions_updated
            ON history_sessions(source_instance_id, updated_at DESC, id)",
        "CREATE INDEX IF NOT EXISTS idx_history_sessions_project
            ON history_sessions(cwd_normalized, updated_at DESC, id)",
        "CREATE INDEX IF NOT EXISTS idx_history_sessions_created
            ON history_sessions(created_at DESC, id)",
        "CREATE TABLE IF NOT EXISTS history_session_artifacts (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            artifact_index INTEGER NOT NULL,
            role TEXT NOT NULL,
            kind TEXT NOT NULL,
            ownership TEXT NOT NULL,
            locator_json TEXT NOT NULL,
            fingerprint_kind TEXT,
            fingerprint_value TEXT,
            writable INTEGER NOT NULL DEFAULT 0,
            source_schema_version TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, artifact_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_session_artifacts_session
            ON history_session_artifacts(session_id)",
        "CREATE TABLE IF NOT EXISTS history_session_relations (
            parent_session_id INTEGER NOT NULL,
            child_session_id INTEGER NOT NULL,
            relation_kind TEXT NOT NULL,
            relation_index INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(parent_session_id, child_session_id, relation_kind),
            FOREIGN KEY(parent_session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(child_session_id) REFERENCES history_sessions(id) ON DELETE CASCADE
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_session_relations_child
            ON history_session_relations(child_session_id)",
        "CREATE TABLE IF NOT EXISTS history_messages (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            message_index INTEGER NOT NULL,
            source_message_id TEXT,
            role TEXT NOT NULL,
            display_content TEXT NOT NULL,
            timestamp_ms INTEGER,
            model TEXT,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cache_read_tokens INTEGER,
            cache_creation_tokens INTEGER,
            editable INTEGER NOT NULL DEFAULT 0,
            raw_pointers_json TEXT,
            source_extension_json TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, message_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_messages_session
            ON history_messages(session_id, message_index)",
        "CREATE TABLE IF NOT EXISTS history_message_parts (
            id INTEGER PRIMARY KEY,
            message_id INTEGER NOT NULL,
            part_index INTEGER NOT NULL,
            kind TEXT NOT NULL,
            text_content TEXT,
            mime_type TEXT,
            tool_call_id TEXT,
            tool_name TEXT,
            content_storage TEXT NOT NULL DEFAULT 'inline',
            payload_json TEXT,
            raw_pointers_json TEXT,
            source_extension_json TEXT,
            FOREIGN KEY(message_id) REFERENCES history_messages(id) ON DELETE CASCADE,
            UNIQUE(message_id, part_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_message_parts_message
            ON history_message_parts(message_id)",
        "CREATE VIRTUAL TABLE IF NOT EXISTS history_messages_fts USING fts5(
            display_content,
            content='history_messages',
            content_rowid='id',
            detail='none',
            tokenize='trigram case_sensitive 0'
        )",
        "CREATE TRIGGER IF NOT EXISTS history_messages_ai AFTER INSERT ON history_messages BEGIN
            INSERT INTO history_messages_fts(rowid, display_content) VALUES (new.id, new.display_content);
        END",
        "CREATE TRIGGER IF NOT EXISTS history_messages_ad AFTER DELETE ON history_messages BEGIN
            INSERT INTO history_messages_fts(history_messages_fts, rowid, display_content)
            VALUES ('delete', old.id, old.display_content);
        END",
        "CREATE TRIGGER IF NOT EXISTS history_messages_au AFTER UPDATE ON history_messages BEGIN
            INSERT INTO history_messages_fts(history_messages_fts, rowid, display_content)
            VALUES ('delete', old.id, old.display_content);
            INSERT INTO history_messages_fts(rowid, display_content) VALUES (new.id, new.display_content);
        END",
        "CREATE TABLE IF NOT EXISTS history_tool_events (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            message_id INTEGER,
            event_index INTEGER NOT NULL,
            call_id TEXT,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            status TEXT,
            timestamp_ms INTEGER,
            duration_ms INTEGER,
            input_summary TEXT,
            output_summary TEXT,
            input_json TEXT,
            output_json TEXT,
            raw_pointers_json TEXT,
            source_extension_json TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(message_id) REFERENCES history_messages(id) ON DELETE SET NULL,
            UNIQUE(session_id, event_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_tool_events_session
            ON history_tool_events(session_id, event_index)",
        "CREATE INDEX IF NOT EXISTS idx_history_tool_events_message
            ON history_tool_events(message_id)",
        "CREATE TABLE IF NOT EXISTS history_usage_events (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            event_index INTEGER NOT NULL,
            timestamp_ms INTEGER,
            model TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            raw_pointers_json TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, event_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_usage_events_session
            ON history_usage_events(session_id)",
        "CREATE TABLE IF NOT EXISTS history_session_model_usage (
            session_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            PRIMARY KEY(session_id, model),
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS history_file_changes (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            change_index INTEGER NOT NULL,
            message_id INTEGER,
            source_kind TEXT NOT NULL,
            tool_name TEXT,
            file_path TEXT NOT NULL,
            old_text TEXT,
            new_text TEXT,
            patch TEXT,
            additions INTEGER NOT NULL DEFAULT 0,
            deletions INTEGER NOT NULL DEFAULT 0,
            timestamp_ms INTEGER,
            raw_pointers_json TEXT,
            FOREIGN KEY(session_id) REFERENCES history_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(message_id) REFERENCES history_messages(id) ON DELETE SET NULL,
            UNIQUE(session_id, change_index)
        )",
        "CREATE INDEX IF NOT EXISTS idx_history_file_changes_session
            ON history_file_changes(session_id)",
        "CREATE INDEX IF NOT EXISTS idx_history_file_changes_message
            ON history_file_changes(message_id)",
        "CREATE TABLE IF NOT EXISTS history_source_state (
            source_instance_id TEXT PRIMARY KEY,
            phase TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 0,
            parser_version INTEGER NOT NULL,
            settings_hash TEXT NOT NULL,
            discovered_sessions INTEGER NOT NULL DEFAULT 0,
            indexed_sessions INTEGER NOT NULL DEFAULT 0,
            failed_sessions INTEGER NOT NULL DEFAULT 0,
            last_started_at INTEGER,
            last_completed_at INTEGER,
            last_success_at INTEGER,
            error_code TEXT,
            error_detail TEXT,
            FOREIGN KEY(source_instance_id)
                REFERENCES history_source_instances(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS history_sync_runs (
            id TEXT PRIMARY KEY,
            source_instance_id TEXT NOT NULL,
            generation INTEGER NOT NULL,
            trigger_kind TEXT NOT NULL,
            phase TEXT NOT NULL,
            discovery_complete INTEGER NOT NULL DEFAULT 0,
            discovered_sessions INTEGER NOT NULL DEFAULT 0,
            changed_sessions INTEGER NOT NULL DEFAULT 0,
            indexed_sessions INTEGER NOT NULL DEFAULT 0,
            failed_sessions INTEGER NOT NULL DEFAULT 0,
            warnings_json TEXT,
            error_code TEXT,
            error_detail TEXT,
            started_at INTEGER NOT NULL,
            completed_at INTEGER,
            FOREIGN KEY(source_instance_id)
                REFERENCES history_source_instances(id) ON DELETE CASCADE
        )",
        "CREATE TABLE IF NOT EXISTS history_index_failures (
            source_instance_id TEXT NOT NULL,
            discovery_key TEXT NOT NULL,
            session_ref_json TEXT NOT NULL,
            fingerprint_value TEXT,
            parser_version INTEGER NOT NULL,
            error_code TEXT NOT NULL,
            error_detail TEXT,
            first_failed_at INTEGER NOT NULL,
            last_failed_at INTEGER NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(source_instance_id, discovery_key),
            FOREIGN KEY(source_instance_id)
                REFERENCES history_source_instances(id) ON DELETE CASCADE
        )",
    ];
    for statement in statements {
        sqlx::query(statement)
            .execute(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
    }
    for (table, column, definition) in [
        (
            "history_source_instances",
            "scope_kind",
            "TEXT NOT NULL DEFAULT 'configured'",
        ),
        (
            "history_source_instances",
            "scope_key",
            "TEXT NOT NULL DEFAULT 'desktop'",
        ),
        (
            "history_source_instances",
            "transport_kind",
            "TEXT NOT NULL DEFAULT 'local'",
        ),
        (
            "history_source_instances",
            "materialization_level",
            "TEXT NOT NULL DEFAULT 'full'",
        ),
        (
            "history_source_instances",
            "freshness_state",
            "TEXT NOT NULL DEFAULT 'fresh'",
        ),
        ("history_source_instances", "as_of", "INTEGER"),
        ("history_source_instances", "remote_identity_json", "TEXT"),
        ("history_source_instances", "sync_cursor_json", "TEXT"),
        (
            "history_sessions",
            "materialization_level",
            "TEXT NOT NULL DEFAULT 'full'",
        ),
        (
            "history_sessions",
            "freshness_state",
            "TEXT NOT NULL DEFAULT 'fresh'",
        ),
        ("history_sessions", "as_of", "INTEGER"),
        ("history_sessions", "tombstoned_at", "INTEGER"),
        ("history_sessions", "parent_session_id", "TEXT"),
    ] {
        ensure_column(conn, table, column, definition).await?;
    }
    if current_version > 0 && current_version < HISTORY_INDEX_SCHEMA_VERSION {
        rebuild_compact_fts(conn).await?;
    }
    sqlx::query("DROP INDEX IF EXISTS idx_history_source_instances_one_active")
        .execute(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_history_source_instances_active_scope
         ON history_source_instances(source_id, scope_kind, scope_key)
         WHERE activation_state = 'active'",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let now = now_millis();
    for (key, value) in [
        ("schema_version", HISTORY_INDEX_SCHEMA_VERSION.to_string()),
        ("model_version", HISTORY_INDEX_MODEL_VERSION.to_string()),
    ] {
        sqlx::query(
            "INSERT INTO history_meta(key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value)
        .bind(now)
        .execute(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    }
    sqlx::query(&format!(
        "PRAGMA user_version = {HISTORY_INDEX_SCHEMA_VERSION}"
    ))
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) async fn rebuild_compact_fts(conn: &mut SqliteConnection) -> Result<(), String> {
    let mut tx = conn.begin().await.map_err(|err| err.to_string())?;
    for (fts_table, source_table, source_column) in [
        (
            "history_catalog_messages_fts",
            "history_catalog_messages",
            "content",
        ),
        (
            "history_messages_fts",
            "history_messages",
            "display_content",
        ),
    ] {
        for trigger in [
            format!("{source_table}_ai"),
            format!("{source_table}_ad"),
            format!("{source_table}_au"),
        ] {
            sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger}"))
                .execute(&mut *tx)
                .await
                .map_err(|err| err.to_string())?;
        }
        sqlx::query(&format!("DROP TABLE IF EXISTS {fts_table}"))
            .execute(&mut *tx)
            .await
            .map_err(|err| err.to_string())?;
        sqlx::query(&format!(
            "CREATE VIRTUAL TABLE {fts_table} USING fts5(
                {source_column},
                content='{source_table}',
                content_rowid='id',
                detail='none',
                tokenize='trigram case_sensitive 0'
            )"
        ))
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
        sqlx::query(&format!(
            "INSERT INTO {fts_table}({fts_table}) VALUES ('rebuild')"
        ))
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
        sqlx::query(&format!(
            "CREATE TRIGGER {source_table}_ai AFTER INSERT ON {source_table} BEGIN
                INSERT INTO {fts_table}(rowid, {source_column}) VALUES (new.id, new.{source_column});
            END"
        ))
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
        sqlx::query(&format!(
            "CREATE TRIGGER {source_table}_ad AFTER DELETE ON {source_table} BEGIN
                INSERT INTO {fts_table}({fts_table}, rowid, {source_column})
                VALUES ('delete', old.id, old.{source_column});
            END"
        ))
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
        sqlx::query(&format!(
            "CREATE TRIGGER {source_table}_au AFTER UPDATE ON {source_table} BEGIN
                INSERT INTO {fts_table}({fts_table}, rowid, {source_column})
                VALUES ('delete', old.id, old.{source_column});
                INSERT INTO {fts_table}(rowid, {source_column}) VALUES (new.id, new.{source_column});
            END"
        ))
        .execute(&mut *tx)
        .await
        .map_err(|err| err.to_string())?;
    }
    tx.commit().await.map_err(|err| err.to_string())?;
    sqlx::query("PRAGMA optimize")
        .execute(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    sqlx::query("VACUUM")
        .execute(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) async fn ensure_column(
    conn: &mut SqliteConnection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
    if rows.iter().any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|name| name == column)
    }) {
        return Ok(());
    }
    sqlx::query(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition}"
    ))
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}
