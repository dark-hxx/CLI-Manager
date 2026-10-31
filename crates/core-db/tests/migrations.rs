use cli_manager_core_db::migrations::migrations;
use sha2::{Digest, Sha384};
use sqlx::Connection;
use tempfile::tempdir;

#[test]
fn historical_migration_bytes_match_pre_extraction_snapshot() {
    let actual: Vec<_> = migrations()
        .into_iter()
        .map(|migration| {
            serde_json::json!({
                "version": migration.version,
                "description": migration.description,
                "sha384": format!("{:x}", Sha384::digest(migration.sql.as_bytes())),
            })
        })
        .collect();
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/main-migrations.json")).unwrap();
    assert_eq!(serde_json::json!(actual), expected);
}

#[tokio::test]
async fn all_migrations_apply_to_a_new_database_in_version_order() {
    let mut connection = sqlx::SqliteConnection::connect("sqlite::memory:")
        .await
        .unwrap();
    let mut last_version = 0;
    for migration in migrations() {
        assert_eq!(migration.version, last_version + 1);
        sqlx::raw_sql(migration.sql)
            .execute(&mut connection)
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "migration {} ({}): {error}",
                    migration.version, migration.description
                )
            });
        last_version = migration.version;
    }
    assert_eq!(last_version, 41);
    let _: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_stars")
        .fetch_one(&mut connection)
        .await
        .unwrap();
}

#[tokio::test]
async fn migrator_applies_and_reopens_the_same_database_without_checksum_drift() {
    let directory = tempdir().unwrap();
    let pool = cli_manager_core_db::pool::DbPool::open(directory.path().join("migrator.db"))
        .await
        .unwrap();
    cli_manager_core_db::run_migrations(pool.writer())
        .await
        .unwrap();
    cli_manager_core_db::run_migrations(pool.writer())
        .await
        .unwrap();
    let applied: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(pool.reader())
            .await
            .unwrap();
    assert_eq!(applied, 41);
    pool.close().await;
}
