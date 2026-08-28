use sha2::{Digest, Sha384};
use sqlx::{Connection, SqliteConnection};
use std::time::Duration;

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

async fn ensure_usage_error_detail_column(connection: &mut SqliteConnection) -> Result<(), String> {
    let column_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('usage_records') WHERE name = 'error_detail'",
    )
    .fetch_one(&mut *connection)
    .await
    .map_err(|err| format!("usage_schema_error_detail_inspect_failed:{err}"))?;
    if column_count == 0 {
        sqlx::query("ALTER TABLE usage_records ADD COLUMN error_detail TEXT")
            .execute(&mut *connection)
            .await
            .map_err(|err| format!("usage_schema_error_detail_add_failed:{err}"))?;
    }
    Ok(())
}

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
         ON CONFLICT(version) DO NOTHING",
    )
    .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_VERSION)
    .bind(crate::MIGRATION_ADD_USAGE_ERROR_DETAIL_DESCRIPTION)
    .bind(checksum)
    .execute(&mut *connection)
    .await
    .map_err(|err| format!("usage_schema_migration_marker_failed:{err}"))?;
    Ok(())
}

async fn ensure_usage_error_detail_schema(connection: &mut SqliteConnection) -> Result<(), String> {
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|err| format!("usage_schema_error_detail_begin_failed:{err}"))?;
    let result = async {
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

pub(crate) async fn ensure_usage_schema(connection: &mut SqliteConnection) -> Result<(), String> {
    for (name, sql) in [
        ("request_logs", crate::MIGRATION_CREATE_REQUEST_LOGS_SQL),
        ("usage_records", crate::MIGRATION_CREATE_USAGE_RECORDS_SQL),
    ] {
        apply_usage_schema_sql(connection, name, sql).await?;
    }
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
    use sqlx::{Connection, Row, SqliteConnection};
    use std::borrow::Cow;
    use tauri_plugin_sql::{Migration, MigrationKind};

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
}
