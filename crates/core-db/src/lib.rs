pub mod extensions;
pub mod history;
pub mod migrations;
pub mod pool;
pub mod projects;
pub mod provider;
use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
use sqlx::SqlitePool;
use std::borrow::Cow;

/// 与桌面框架无关的历史向上迁移定义。
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub description: &'static str,
    pub sql: &'static str,
}

/// 将中立迁移定义转换为 SQLx Migrator，供 GPUI 或其他宿主初始化数据库。
pub fn migrator() -> Migrator {
    let migrations = migrations::migrations()
        .into_iter()
        .map(|migration| {
            SqlxMigration::new(
                migration.version,
                migration.description.into(),
                MigrationType::ReversibleUp,
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

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    migrator().run(pool).await
}
