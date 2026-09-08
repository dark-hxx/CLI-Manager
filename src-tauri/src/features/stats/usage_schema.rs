use sha2::{Digest, Sha384};
use sqlx::{Connection, Row, SqliteConnection};
use std::time::Duration;

// 查询 SQLite 中指定类型和名称的结构对象是否存在。
async fn sqlite_object_exists(
    connection: &mut SqliteConnection,
    object_type: &str,
    name: &str,
) -> Result<bool, String> {
    sqlx::query_scalar(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2
         )",
    )
    .bind(object_type)
    .bind(name)
    .fetch_one(&mut *connection)
    .await
    .map_err(|err| format!("usage_schema_object_inspect_failed:{object_type}:{name}:{err}"))
}

// 检查 usage_records 是否已包含错误详情列。
async fn usage_error_detail_column_exists(
    connection: &mut SqliteConnection,
) -> Result<bool, String> {
    let column_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('usage_records') WHERE name = 'error_detail'",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|err| format!("usage_schema_error_detail_inspect_failed:{err}"))?;
    Ok(column_count != 0)
}

// 核对错误详情迁移标记的成功状态、描述和 SQL 摘要。
async fn usage_error_detail_marker_matches(
    connection: &mut SqliteConnection,
) -> Result<bool, String> {
    if !sqlite_object_exists(connection, "table", "_sqlx_migrations").await? {
        return Ok(false);
    }
    let marker = sqlx::query(
        "SELECT description, checksum
         FROM _sqlx_migrations
         WHERE version = ?1 AND success = 1
         LIMIT 1",
    )
    .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|err| format!("usage_schema_error_detail_marker_inspect_failed:{err}"))?;
    let Some(marker) = marker else {
        return Ok(false);
    };
    let description: String = marker
        .try_get("description")
        .map_err(|err| format!("usage_schema_error_detail_marker_description_failed:{err}"))?;
    let checksum: Vec<u8> = marker
        .try_get("checksum")
        .map_err(|err| format!("usage_schema_error_detail_marker_checksum_failed:{err}"))?;
    Ok(
        description == crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION
            && checksum
                == Sha384::digest(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL.as_bytes()).to_vec(),
    )
}

// 检查统一用量视图是否同时暴露项目路径和错误详情。
async fn usage_view_has_required_columns(
    connection: &mut SqliteConnection,
) -> Result<bool, String> {
    let column_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
         FROM pragma_table_info('unified_usage_records')
         WHERE name IN ('project_path', 'error_detail')",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|err| format!("usage_schema_view_columns_inspect_failed:{err}"))?;
    Ok(column_count == 2)
}

// 逐项验证用量表、视图、索引及错误详情迁移标记是否齐备。
async fn usage_schema_is_ready(connection: &mut SqliteConnection) -> Result<bool, String> {
    const REQUIRED_OBJECTS: &[(&str, &str)] = &[
        ("table", "request_logs"),
        ("table", "request_log_sync"),
        ("table", "usage_records"),
        ("table", "usage_daily_rollups"),
        ("view", "unified_usage_records"),
        ("index", "idx_request_logs_time"),
        ("index", "idx_request_logs_source_project"),
        ("index", "idx_request_logs_session"),
        ("index", "idx_request_logs_model"),
        ("index", "idx_usage_records_time"),
        ("index", "idx_usage_records_project"),
        ("index", "idx_usage_records_session"),
        ("index", "idx_usage_records_provider"),
        ("index", "idx_usage_records_source"),
        ("index", "idx_usage_records_route_dedup"),
        ("index", "idx_usage_records_project_path"),
    ];
    for (object_type, name) in REQUIRED_OBJECTS {
        if !sqlite_object_exists(connection, object_type, name).await? {
            return Ok(false);
        }
    }
    Ok(usage_error_detail_column_exists(connection).await?
        && usage_view_has_required_columns(connection).await?
        && usage_error_detail_marker_matches(connection).await?)
}

// 依次执行按分号拆分的内置用量结构 SQL。
async fn apply_usage_schema_sql(
    connection: &mut SqliteConnection,
    name: &str,
    sql: &str,
) -> Result<(), String> {
    for statement in sql
        .split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
    {
        sqlx::query(statement)
            .execute(&mut *connection)
            .await
            .map_err(|err| format!("usage_schema_bootstrap_failed:{name}:{err}"))?;
    }
    Ok(())
}

// 仅在缺失时为用量记录添加可空错误详情列。
async fn ensure_usage_error_detail_column(connection: &mut SqliteConnection) -> Result<(), String> {
    if !usage_error_detail_column_exists(connection).await? {
        sqlx::query("ALTER TABLE usage_records ADD COLUMN error_detail TEXT")
            .execute(&mut *connection)
            .await
            .map_err(|err| format!("usage_schema_error_detail_add_failed:{err}"))?;
    }
    Ok(())
}

// 确保迁移记录表存在，并写入与正式迁移一致的错误详情标记。
async fn mark_usage_error_detail_migration(
    connection: &mut SqliteConnection,
) -> Result<(), String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        )",
    )
    .execute(&mut *connection)
    .await
    .map_err(|err| format!("usage_schema_migration_table_failed:{err}"))?;

    let checksum = Sha384::digest(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL.as_bytes()).to_vec();
    sqlx::query(
        "INSERT INTO _sqlx_migrations(
            version, description, success, checksum, execution_time
         ) VALUES (?1, ?2, TRUE, ?3, 0)
         ON CONFLICT(version) DO UPDATE SET
            description = excluded.description,
            success = excluded.success,
            checksum = excluded.checksum,
            execution_time = excluded.execution_time",
    )
    .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
    .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION)
    .bind(checksum)
    .execute(&mut *connection)
    .await
    .map_err(|err| format!("usage_schema_migration_marker_failed:{err}"))?;
    Ok(())
}

// 在立即事务中补齐错误详情列、视图和迁移标记，失败时回滚。
async fn ensure_usage_error_detail_schema(connection: &mut SqliteConnection) -> Result<(), String> {
    if usage_error_detail_column_exists(connection).await?
        && usage_view_has_required_columns(connection).await?
        && usage_error_detail_marker_matches(connection).await?
    {
        return Ok(());
    }
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|err| format!("usage_schema_error_detail_begin_failed:{err}"))?;
    let result = async {
        if usage_error_detail_column_exists(connection).await?
            && usage_view_has_required_columns(connection).await?
            && usage_error_detail_marker_matches(connection).await?
        {
            return Ok(());
        }
        ensure_usage_error_detail_column(connection).await?;
        apply_usage_schema_sql(
            connection,
            "route_usage_error_detail",
            crate::MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_WITH_ERROR_DETAIL_SQL,
        )
        .await?;
        mark_usage_error_detail_migration(connection).await
    }
    .await;
    match result {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|err| format!("usage_schema_error_detail_commit_failed:{err}")),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

// 快速检查就绪状态，必要时依次引导用量结构并补齐错误详情迁移。
pub(crate) async fn ensure_usage_schema(connection: &mut SqliteConnection) -> Result<(), String> {
    if usage_schema_is_ready(connection).await? {
        return Ok(());
    }
    apply_usage_schema_sql(
        connection,
        "request_logs",
        crate::MIGRATION_CREATE_REQUEST_LOGS_SQL,
    )
    .await?;
    apply_usage_schema_sql(
        connection,
        "usage_records",
        crate::MIGRATION_CREATE_USAGE_RECORDS_SQL,
    )
    .await?;
    for (name, sql) in [
        (
            "unified_usage_records",
            crate::MIGRATION_RECREATE_UNIFIED_USAGE_RECORDS_SQL,
        ),
        (
            "optimized_unified_usage_records",
            crate::MIGRATION_OPTIMIZE_UNIFIED_USAGE_RECORDS_SQL,
        ),
        (
            "materialized_request_log_project_path",
            crate::MIGRATION_MATERIALIZE_REQUEST_LOG_PROJECT_PATH_SQL,
        ),
    ] {
        apply_usage_schema_sql(connection, name, sql).await?;
    }
    ensure_usage_error_detail_schema(connection).await
}

// 打开可创建的应用用量数据库，并确保所需结构已经就绪。
pub(crate) async fn open_usage_database() -> Result<SqliteConnection, String> {
    let path = crate::app_paths::db_path()?;
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(15));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|err| format!("usage_db_open_failed: {err}"))?;
    ensure_usage_schema(&mut connection).await?;
    Ok(connection)
}

#[cfg(test)]
mod tests {
    use super::ensure_usage_schema;
    use sha2::{Digest, Sha384};
    use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::{Connection, Row, SqliteConnection};
    use std::borrow::Cow;
    use tauri_plugin_sql::{Migration, MigrationKind};

    // 将 Tauri SQL 迁移列表转换为测试用 SQLx 迁移器。
    fn sqlx_migrator(migrations: Vec<Migration>) -> Migrator {
        let migrations = migrations
            .into_iter()
            .map(|migration| {
                let migration_type = match migration.kind {
                    MigrationKind::Up => MigrationType::ReversibleUp,
                    MigrationKind::Down => MigrationType::ReversibleDown,
                };
                SqlxMigration::new(
                    migration.version,
                    migration.description.into(),
                    migration_type,
                    migration.sql.into(),
                    false,
                )
            })
            .collect();
        Migrator {
            migrations: Cow::Owned(migrations),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        }
    }

    #[tokio::test]
    // 验证旧用量结构重复引导只添加一次错误详情列及正确迁移标记。
    async fn bootstrap_adds_route_error_detail_once_for_legacy_usage_schema() {
        let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::raw_sql(crate::MIGRATION_CREATE_REQUEST_LOGS_SQL)
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(crate::MIGRATION_CREATE_USAGE_RECORDS_SQL)
            .execute(&mut connection)
            .await
            .unwrap();

        ensure_usage_schema(&mut connection).await.unwrap();
        ensure_usage_schema(&mut connection).await.unwrap();

        let row = sqlx::query(
            "SELECT COUNT(*) AS count
             FROM pragma_table_info('usage_records')
             WHERE name = 'error_detail'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(row.get::<i64, _>("count"), 1);

        let marker: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ?1")
                .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(marker, 1);
        let migration = sqlx::query(
            "SELECT description, success, checksum
             FROM _sqlx_migrations
             WHERE version = ?1",
        )
        .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(
            migration.get::<String, _>("description"),
            crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION
        );
        assert!(migration.get::<bool, _>("success"));
        assert_eq!(
            migration.get::<Vec<u8>, _>("checksum"),
            Sha384::digest(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL.as_bytes()).to_vec()
        );
    }

    #[tokio::test]
    // 验证引导标记允许 SQLx 跳过同一 v33 迁移。
    async fn bootstrap_marker_allows_sqlx_to_skip_the_same_v33_migration() {
        let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::raw_sql(crate::MIGRATION_CREATE_REQUEST_LOGS_SQL)
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(crate::MIGRATION_CREATE_USAGE_RECORDS_SQL)
            .execute(&mut connection)
            .await
            .unwrap();
        ensure_usage_schema(&mut connection).await.unwrap();

        let migration = crate::migrations()
            .into_iter()
            .find(|migration| migration.version == crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
            .expect("v33 migration is registered");
        let migrator = sqlx_migrator(vec![migration]);

        migrator.run(&mut connection).await.unwrap();
    }

    #[tokio::test]
    // 验证引导后的数据库兼容完整插件迁移列表。
    async fn bootstrap_marker_is_compatible_with_the_full_plugin_migration_list() {
        let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
        sqlx::raw_sql(crate::MIGRATION_CREATE_REQUEST_LOGS_SQL)
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(crate::MIGRATION_CREATE_USAGE_RECORDS_SQL)
            .execute(&mut connection)
            .await
            .unwrap();
        ensure_usage_schema(&mut connection).await.unwrap();

        sqlx_migrator(crate::migrations())
            .run(&mut connection)
            .await
            .unwrap();
    }

    #[tokio::test]
    // 验证结构齐备时只读连接也能通过引导检查。
    async fn ready_schema_bootstrap_succeeds_on_read_only_connection() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("usage.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx_migrator(crate::migrations())
            .run(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();

        let options = SqliteConnectOptions::new().filename(&path).read_only(true);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        ensure_usage_schema(&mut connection).await.unwrap();
    }

    #[tokio::test]
    // 验证引导恢复缺失索引后可在只读查询模式下重复调用。
    async fn bootstrap_restores_missing_required_indexes() {
        let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
        ensure_usage_schema(&mut connection).await.unwrap();
        sqlx::query("DROP INDEX idx_usage_records_route_dedup")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("DROP INDEX idx_request_logs_model")
            .execute(&mut connection)
            .await
            .unwrap();

        ensure_usage_schema(&mut connection).await.unwrap();

        for name in ["idx_usage_records_route_dedup", "idx_request_logs_model"] {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
            )
            .bind(name)
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(count, 1, "missing repaired index {name}");
        }
        sqlx::query("SELECT project_path, error_code, error_detail FROM unified_usage_records LIMIT 0")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        sqlx::query("PRAGMA query_only = ON").execute(&mut connection).await.unwrap();
        ensure_usage_schema(&mut connection).await.unwrap();
    }

    #[tokio::test]
    // 验证引导修复错误详情迁移中陈旧的描述与摘要。
    async fn bootstrap_repairs_stale_usage_error_detail_marker() {
        let mut connection = SqliteConnection::connect(":memory:").await.unwrap();
        ensure_usage_schema(&mut connection).await.unwrap();
        sqlx::query(
            "UPDATE _sqlx_migrations
             SET description = 'stale', checksum = x'00'
             WHERE version = ?1",
        )
        .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
        .execute(&mut connection)
        .await
        .unwrap();

        ensure_usage_schema(&mut connection).await.unwrap();

        let marker =
            sqlx::query("SELECT description, checksum FROM _sqlx_migrations WHERE version = ?1")
                .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            marker.get::<String, _>("description"),
            crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION
        );
        assert_eq!(
            marker.get::<Vec<u8>, _>("checksum"),
            Sha384::digest(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_SQL.as_bytes()).to_vec()
        );
    }
}
