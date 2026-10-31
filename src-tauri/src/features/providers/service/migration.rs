#[cfg(test)]
pub(crate) use cli_manager_core_db::provider::{
    MIGRATION_CREATE_NATIVE_PROVIDERS_SQL, MIGRATION_LEGACY_PROVIDERS_SQL,
};
#[cfg(test)]
pub(crate) use cli_manager_core_db::provider::{
    MIGRATION_CREATE_NATIVE_PROVIDERS_VERSION, MIGRATION_LEGACY_PROVIDERS_VERSION,
};

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha384};
    use sqlx::{Connection, Executor, Row, SqliteConnection};

    #[test]
    // 验证已发布 V25 迁移 SQL 的固定 SHA-384 摘要，防止破坏历史数据库校验。
    fn legacy_provider_migration_keeps_the_shipped_v25_checksum() {
        let checksum = Sha384::digest(MIGRATION_LEGACY_PROVIDERS_SQL.as_bytes());
        assert_eq!(
            format!("{checksum:x}"),
            "739c40c1d5a2fd5420c5475a984fb0f7e9c86af4083f76e66b658af0bf36c8c79f2d63b766fed482d8d987060566f82e"
        );
    }

    #[tokio::test]
    // 在内存数据库验证历史原型表限制单一活动密钥，删除供应商时级联清除密钥。
    async fn native_provider_schema_enforces_active_key_and_cascade_contracts() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute("PRAGMA foreign_keys = ON").await.unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_NATIVE_PROVIDERS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        let now = 1_i64;
        sqlx::query(
            "INSERT INTO managed_providers
             (id, cli_type, name, name_normalized, status, config_format, created_at, updated_at)
             VALUES ('p1', 'claude', 'Provider', 'provider', 'ready', 'json', ?1, ?1)",
        )
        .bind(now)
        .execute(&mut conn)
        .await
        .unwrap();

        for id in ["k1", "k2"] {
            let result = sqlx::query(
                "INSERT INTO managed_provider_keys
                 (id, provider_id, label, secret_text, secret_hint, secret_fingerprint,
                  is_active, created_at, updated_at)
                 VALUES (?1, 'p1', ?1, 'plain-secret', 'plain...cret', ?1, 1, ?2, ?2)",
            )
            .bind(id)
            .bind(now)
            .execute(&mut conn)
            .await;
            if id == "k1" {
                result.unwrap();
            } else {
                assert!(result.is_err(), "a second active key must be rejected");
            }
        }

        sqlx::query("DELETE FROM managed_providers WHERE id = 'p1'")
            .execute(&mut conn)
            .await
            .unwrap();
        let remaining: i64 = sqlx::query("SELECT COUNT(*) AS count FROM managed_provider_keys")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .get("count");
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    // 在内存数据库依次执行 V25 与历史原型迁移，验证旧表与原型表均存在。
    async fn native_provider_schema_applies_after_legacy_v25_schema() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute("PRAGMA foreign_keys = ON").await.unwrap();
        sqlx::raw_sql(MIGRATION_LEGACY_PROVIDERS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_NATIVE_PROVIDERS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();

        for table in [
            "providers",
            "provider_keys",
            "managed_providers",
            "managed_provider_keys",
            "managed_provider_global_state",
        ] {
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            )
            .bind(table)
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert_eq!(exists, 1, "expected migration table {table}");
        }
    }

    #[tokio::test]
    // 验证历史原型表拒绝 Codex 使用 JSON 配置格式，不涉及当前独立供应商数据库。
    async fn native_provider_schema_rejects_cross_type_config_formats() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(MIGRATION_CREATE_NATIVE_PROVIDERS_SQL)
            .execute(&mut conn)
            .await
            .unwrap();
        let result = sqlx::query(
            "INSERT INTO managed_providers
             (id, cli_type, name, name_normalized, status, config_format, created_at, updated_at)
             VALUES ('p1', 'codex', 'Provider', 'provider', 'draft', 'json', 1, 1)",
        )
        .execute(&mut conn)
        .await;
        assert!(result.is_err());
    }
}
