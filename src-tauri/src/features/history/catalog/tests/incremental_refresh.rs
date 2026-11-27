use super::*;

// 构造只含角色与正文的目录测试消息。
fn catalog_test_message(role: &str, content: &str) -> HistoryMessage {
    HistoryMessage {
        role: role.to_string(),
        content: content.to_string(),
        parts: Vec::new(),
        timestamp: None,
        model: None,
        input_tokens: None,
        output_tokens: None,
        cache_creation_tokens: None,
        cache_read_tokens: None,
        line_index: None,
        editable: false,
        editable_text: None,
    }
}

// 构造固定文件路径、指定消息列表的目录测试文档。
fn catalog_test_document(messages: Vec<HistoryMessage>) -> CatalogDocument {
    CatalogDocument {
        file_ref: SessionFileRef {
            source: "claude".to_string(),
            project_key: "project".to_string(),
            path: PathBuf::from("session.jsonl"),
        },
        fingerprint: SessionFileFingerprint::default(),
        computed: CachedSessionComputation {
            created_at: 1,
            updated_at: 2,
            session_id: "session-1".to_string(),
            parent_session_id: None,
            title: "title".to_string(),
            message_count: messages.len(),
            branch: None,
            stats: Arc::new(SessionStatsScan::default()),
        },
        cwd: None,
        messages,
    }
}

// 按序号读取测试文件的消息行 id 与正文。
async fn catalog_test_rows(conn: &mut SqliteConnection) -> Vec<(i64, i64, String)> {
    sqlx::query(
        "SELECT id, message_index, content FROM history_catalog_messages
         WHERE roots_key = 'roots' AND file_path = 'session.jsonl'
         ORDER BY message_index",
    )
    .fetch_all(&mut *conn)
    .await
    .unwrap()
    .into_iter()
    .map(|row| {
        (
            row.get::<i64, _>("id"),
            row.get::<i64, _>("message_index"),
            row.get::<String, _>("content"),
        )
    })
    .collect()
}

// 统计关键字的全文索引命中数，并校验 FTS 与消息表一致。
async fn catalog_fts_hits(conn: &mut SqliteConnection, literal: &str) -> i64 {
    sqlx::query(
        "INSERT INTO history_catalog_messages_fts(history_catalog_messages_fts)
         VALUES ('integrity-check')",
    )
    .execute(&mut *conn)
    .await
    .unwrap();
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM history_catalog_messages_fts
         WHERE history_catalog_messages_fts MATCH ?1",
    )
    .bind(fts_trigram_query(literal))
    .fetch_one(&mut *conn)
    .await
    .unwrap()
}

#[tokio::test]
// 验证追加消息只插入新行，已有行 id 保持不变。
async fn replace_document_appends_only_new_messages() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    let first = vec![
        catalog_test_message("user", "alpha question"),
        catalog_test_message("assistant", "bravo answer"),
    ];
    replace_document(&mut conn, "roots", catalog_test_document(first.clone()))
        .await
        .unwrap();
    let before = catalog_test_rows(&mut conn).await;

    let mut second = first;
    second.push(catalog_test_message("user", "charlie followup"));
    replace_document(&mut conn, "roots", catalog_test_document(second))
        .await
        .unwrap();
    let after = catalog_test_rows(&mut conn).await;

    assert_eq!(after.len(), 3);
    assert_eq!(&after[..2], &before[..]);
    assert_eq!(after[2].2, "charlie followup");
    assert_eq!(catalog_fts_hits(&mut conn, "charlie").await, 1);
    assert_eq!(catalog_fts_hits(&mut conn, "bravo").await, 1);
    let message_count: i64 = sqlx::query_scalar(
        "SELECT message_count FROM history_catalog_sessions
         WHERE roots_key = 'roots' AND file_path = 'session.jsonl'",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(message_count, 3);
}

#[tokio::test]
// 验证同序号正文变化时原地更新消息行并同步全文索引。
async fn replace_document_updates_changed_message_and_fts() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    replace_document(
        &mut conn,
        "roots",
        catalog_test_document(vec![
            catalog_test_message("user", "alpha question"),
            catalog_test_message("assistant", "bravo draft"),
        ]),
    )
    .await
    .unwrap();
    let before = catalog_test_rows(&mut conn).await;

    replace_document(
        &mut conn,
        "roots",
        catalog_test_document(vec![
            catalog_test_message("user", "alpha question"),
            catalog_test_message("assistant", "delta final"),
        ]),
    )
    .await
    .unwrap();
    let after = catalog_test_rows(&mut conn).await;

    assert_eq!(after.len(), 2);
    assert_eq!(after[0], before[0]);
    assert_eq!(after[1].0, before[1].0);
    assert_eq!(after[1].2, "delta final");
    assert_eq!(catalog_fts_hits(&mut conn, "bravo").await, 0);
    assert_eq!(catalog_fts_hits(&mut conn, "delta").await, 1);
}

#[tokio::test]
// 验证消息变少时删除尾部行及其全文索引。
async fn replace_document_truncates_removed_tail() {
    let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    ensure_schema(&mut conn).await.unwrap();
    replace_document(
        &mut conn,
        "roots",
        catalog_test_document(vec![
            catalog_test_message("user", "alpha question"),
            catalog_test_message("assistant", "bravo answer"),
            catalog_test_message("user", "charlie followup"),
        ]),
    )
    .await
    .unwrap();

    replace_document(
        &mut conn,
        "roots",
        catalog_test_document(vec![catalog_test_message("user", "alpha question")]),
    )
    .await
    .unwrap();

    let rows = catalog_test_rows(&mut conn).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].2, "alpha question");
    assert_eq!(catalog_fts_hits(&mut conn, "bravo").await, 0);
    assert_eq!(catalog_fts_hits(&mut conn, "charlie").await, 0);
    assert_eq!(catalog_fts_hits(&mut conn, "alpha").await, 1);
}

#[test]
// 验证目录整理需同时满足空闲字节与空闲占比阈值。
fn catalog_vacuum_requires_free_bytes_and_ratio() {
    let page_size = 4096;
    let threshold_pages = CATALOG_VACUUM_MIN_FREE_BYTES / page_size;
    assert!(catalog_needs_vacuum(
        page_size,
        threshold_pages * 2,
        threshold_pages
    ));
    assert!(!catalog_needs_vacuum(
        page_size,
        threshold_pages * 10,
        threshold_pages
    ));
    assert!(!catalog_needs_vacuum(page_size, 2_000, 1_000));
    assert!(!catalog_needs_vacuum(0, 0, 0));
}
