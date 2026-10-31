use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const STATEMENT_CACHE_CAPACITY: usize = 100;

/// SQLite 的读写池。写池固定单连接，读池允许并发；两个池共享同一数据库文件。
pub struct DbPool {
    writer: SqlitePool,
    reader: SqlitePool,
}

impl DbPool {
    /// 打开并初始化数据库连接池。只设置连接级参数，不执行业务迁移。
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, sqlx::Error> {
        let path = path.as_ref();
        Self::open_pools(path, true).await
    }

    /// 打开既有数据库用于共享数据写入；若文件在检查后消失，也不会重新创建。
    pub async fn open_existing(path: impl AsRef<Path>) -> Result<Self, sqlx::Error> {
        let path = path.as_ref();
        if !path.try_exists().map_err(sqlx::Error::Io)? {
            return Err(sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "database does not exist",
            )));
        }
        Self::open_pools(path, false).await
    }

    async fn open_pools(path: &Path, create_if_missing: bool) -> Result<Self, sqlx::Error> {
        let writer = open_pool(path, 1, false, create_if_missing).await?;
        let reader_count = std::thread::available_parallelism()
            .map(|count| count.get().min(4) as u32)
            .unwrap_or(1);
        let reader = match open_pool(path, reader_count, true, false).await {
            Ok(reader) => reader,
            Err(error) => {
                writer.close().await;
                return Err(error);
            }
        };
        Ok(Self { writer, reader })
    }

    pub fn writer(&self) -> &SqlitePool {
        &self.writer
    }

    pub fn reader(&self) -> &SqlitePool {
        &self.reader
    }

    /// 等待两组连接关闭，确保 Windows 上能够安全释放数据库文件。
    pub async fn close(&self) {
        self.reader.close().await;
        self.writer.close().await;
    }
}

async fn open_pool(
    path: &Path,
    max_connections: u32,
    read_only: bool,
    create_if_missing: bool,
) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(create_if_missing)
        .read_only(read_only)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(BUSY_TIMEOUT)
        .foreign_keys(true)
        .statement_cache_capacity(STATEMENT_CACHE_CAPACITY)
        .pragma("temp_store", "MEMORY")
        .pragma("cache_size", "-16000")
        .pragma("mmap_size", "268435456");
    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .connect_with(options)
        .await
}

/// 多库场景的最小容器；后续按功能域填充 providers/history catalog。
pub struct DbPools {
    pub main: DbPool,
}

impl DbPools {
    pub async fn open_main(path: impl AsRef<Path>) -> Result<Self, sqlx::Error> {
        Ok(Self {
            main: DbPool::open(path).await?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn initializes_wal_and_foreign_keys_for_both_pool_types() {
        let directory = tempdir().unwrap();
        let pool = DbPool::open(directory.path().join("main.db"))
            .await
            .unwrap();
        for database in [pool.writer(), pool.reader()] {
            let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
                .fetch_one(database)
                .await
                .unwrap();
            let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
                .fetch_one(database)
                .await
                .unwrap();
            assert_eq!(journal.to_ascii_lowercase(), "wal");
            assert_eq!(foreign_keys, 1);
            for (pragma, expected) in [
                ("PRAGMA synchronous", 1),
                ("PRAGMA busy_timeout", 5000),
                ("PRAGMA temp_store", 2),
                ("PRAGMA cache_size", -16000),
                ("PRAGMA mmap_size", 268435456),
            ] {
                let actual: i64 = sqlx::query_scalar(pragma)
                    .fetch_one(database)
                    .await
                    .unwrap();
                assert_eq!(actual, expected, "{pragma}");
            }
        }
        assert!(sqlx::query("CREATE TABLE forbidden (id INTEGER)")
            .execute(pool.reader())
            .await
            .is_err());
        pool.close().await;
    }

    #[tokio::test]
    async fn concurrent_reads_and_serial_writes_share_the_database() {
        let directory = tempdir().unwrap();
        let pool = std::sync::Arc::new(
            DbPool::open(directory.path().join("main.db"))
                .await
                .unwrap(),
        );
        sqlx::query("CREATE TABLE values_table (value INTEGER NOT NULL)")
            .execute(pool.writer())
            .await
            .unwrap();
        for value in 0..32_i64 {
            sqlx::query("INSERT INTO values_table (value) VALUES (?1)")
                .bind(value)
                .execute(pool.writer())
                .await
                .unwrap();
        }
        let readers: Vec<_> = (0..16)
            .map(|_| {
                let pool = pool.clone();
                tokio::spawn(async move {
                    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM values_table")
                        .fetch_one(pool.reader())
                        .await
                })
            })
            .collect();
        for reader in readers {
            assert_eq!(reader.await.unwrap().unwrap(), 32);
        }
        pool.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sixteen_readers_and_two_writers_run_for_ten_seconds_without_lock_errors() {
        let directory = tempdir().unwrap();
        let pool = std::sync::Arc::new(
            DbPool::open(directory.path().join("stress.db"))
                .await
                .unwrap(),
        );
        sqlx::query("CREATE TABLE counter (value INTEGER NOT NULL)")
            .execute(pool.writer())
            .await
            .unwrap();
        sqlx::query("INSERT INTO counter VALUES (0)")
            .execute(pool.writer())
            .await
            .unwrap();
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(19));
        let mut tasks = Vec::new();
        for worker in 0..18 {
            let pool = pool.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut operations = 0_i64;
                while std::time::Instant::now() < deadline {
                    if worker < 2 {
                        let mut transaction = pool.writer().begin().await.unwrap();
                        sqlx::query("UPDATE counter SET value = value + 1")
                            .execute(&mut *transaction)
                            .await
                            .unwrap();
                        let _: i64 = sqlx::query_scalar("SELECT value FROM counter")
                            .fetch_one(&mut *transaction)
                            .await
                            .unwrap();
                        transaction.commit().await.unwrap();
                    } else {
                        let _: i64 = sqlx::query_scalar("SELECT value FROM counter")
                            .fetch_one(pool.reader())
                            .await
                            .unwrap();
                    }
                    operations += 1;
                }
                (worker, operations)
            }));
        }
        barrier.wait().await;
        let mut writes = 0;
        for task in tasks {
            let (worker, operations) = task.await.unwrap();
            assert!(operations > 0, "worker {worker} made no progress");
            if worker < 2 {
                writes += operations;
            }
        }
        let value: i64 = sqlx::query_scalar("SELECT value FROM counter")
            .fetch_one(pool.reader())
            .await
            .unwrap();
        assert_eq!(value, writes);
        pool.close().await;
    }
}
