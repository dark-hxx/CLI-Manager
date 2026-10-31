use cli_manager_core_db::{
    history::{
        delete_favorite_snapshot, update_session_meta, upsert_favorite_snapshot,
        FavoriteSnapshotPatch, SessionMetaPatch,
    },
    pool::DbPool,
    projects::ProjectRepo,
    run_migrations,
};

#[tokio::test]
async fn readonly_entry_never_creates_a_missing_database_or_writes_existing_one() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing.db");
    assert!(ProjectRepo::open_read_only(&path).await.is_err());
    assert!(!path.exists());
    let pool = DbPool::open(&path).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    let repo = ProjectRepo::open_read_only(&path).await.unwrap();
    assert!(repo.snapshot().await.unwrap().projects.is_empty());
    sqlx::query("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('p', 'Live', 'C:/live', '', '')")
        .execute(pool.writer()).await.unwrap();
    assert_eq!(repo.find_project("p").await.unwrap().unwrap().name, "Live");
    repo.close().await;
    pool.close().await;
}

#[tokio::test]
async fn reads_migrated_defaults_and_matches_frontend_ordering() {
    let directory = tempfile::tempdir().unwrap();
    let pool = DbPool::open(directory.path().join("projects.db"))
        .await
        .unwrap();
    run_migrations(pool.writer()).await.unwrap();
    let repo = ProjectRepo::new(pool.reader().clone());
    assert!(repo.snapshot().await.unwrap().projects.is_empty());
    for (id, name, order) in [("z", "Zulu", 1), ("b", "Beta", 0), ("a", "Alpha", 0)] {
        sqlx::query("INSERT INTO groups (id, name, sort_order) VALUES (?1, ?2, ?3)")
            .bind(id)
            .bind(name)
            .bind(order)
            .execute(pool.writer())
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path, group_id, sort_order, created_at, updated_at) VALUES (?1, ?2, 'C:/fallback', ?1, ?3, 'created', 'updated')")
            .bind(id).bind(name).bind(order).execute(pool.writer()).await.unwrap();
    }
    let snapshot = repo.snapshot().await.unwrap();
    assert_eq!(
        snapshot
            .projects
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b", "z"]
    );
    assert_eq!(repo.list_projects().await.unwrap(), snapshot.projects);
    assert_eq!(repo.list_groups().await.unwrap(), snapshot.groups);
    let project = repo.find_project("a").await.unwrap().unwrap();
    assert_eq!(project.group_id.as_deref(), Some("a"));
    assert_eq!(project.shell, "powershell");
    assert_eq!(project.path_mode, "custom");
    assert_eq!(project.environment_type, "local");
    assert_eq!(project.worktree_strategy, "disabled");
    assert_eq!(project.provider_overrides, "{}");
    assert_eq!(project.env_vars, "{}");
    assert_eq!(project.ssh_host_id, None);
    assert_eq!(project.created_at, "created");
    assert_eq!(project.updated_at, "updated");
    assert!(repo.find_project("' OR 1=1 --").await.unwrap().is_none());
    pool.close().await;
}

#[tokio::test]
async fn inherited_paths_follow_nearest_binding_and_survive_bad_ancestry() {
    let directory = tempfile::tempdir().unwrap();
    let pool = DbPool::open(directory.path().join("paths.db"))
        .await
        .unwrap();
    run_migrations(pool.writer()).await.unwrap();
    sqlx::query("INSERT INTO groups (id, name, bound_path) VALUES ('root', 'Root', ' C:/root ')")
        .execute(pool.writer())
        .await
        .unwrap();
    sqlx::query("INSERT INTO groups (id, name, parent_id) VALUES ('child', 'Child', 'root')")
        .execute(pool.writer())
        .await
        .unwrap();
    sqlx::query("INSERT INTO projects (id, name, path, path_mode, group_id, created_at, updated_at) VALUES ('p', 'Project', 'C:/fallback', 'inherit', 'child', '', '')")
        .execute(pool.writer()).await.unwrap();
    let repo = ProjectRepo::new(pool.reader().clone());
    let mut snapshot = repo.snapshot().await.unwrap();
    assert_eq!(snapshot.project_path(&snapshot.projects[0]), "C:/root");
    snapshot
        .groups
        .iter_mut()
        .find(|g| g.id == "child")
        .unwrap()
        .bound_path = "C:/child".into();
    assert_eq!(snapshot.project_path(&snapshot.projects[0]), "C:/child");
    for group in &mut snapshot.groups {
        group.bound_path.clear();
    }
    snapshot
        .groups
        .iter_mut()
        .find(|g| g.id == "root")
        .unwrap()
        .parent_id = Some("child".into());
    assert_eq!(snapshot.project_path(&snapshot.projects[0]), "C:/fallback");
    snapshot.groups.clear();
    assert_eq!(snapshot.project_path(&snapshot.projects[0]), "C:/fallback");
    snapshot.projects[0].path_mode = "custom".into();
    assert_eq!(snapshot.project_path(&snapshot.projects[0]), "C:/fallback");
    pool.close().await;
}

#[tokio::test]
async fn tree_rows_match_group_then_project_depth_first_order() {
    let directory = tempfile::tempdir().unwrap();
    let pool = DbPool::open(directory.path().join("tree.db"))
        .await
        .unwrap();
    run_migrations(pool.writer()).await.unwrap();
    sqlx::query("INSERT INTO groups (id, name, sort_order) VALUES ('b', 'B', 1), ('a', 'A', 0), ('a1', 'A1', 0)")
        .execute(pool.writer()).await.unwrap();
    sqlx::query("UPDATE groups SET parent_id = 'a' WHERE id = 'a1'")
        .execute(pool.writer())
        .await
        .unwrap();
    for (id, name, group_id, order) in [
        ("root-p", "Root", None, 1),
        ("child-p", "Child", Some("a1"), 0),
        ("a-p", "A project", Some("a"), 1),
    ] {
        sqlx::query("INSERT INTO projects (id, name, path, group_id, sort_order, created_at, updated_at) VALUES (?1, ?2, '', ?3, ?4, '', '')")
            .bind(id).bind(name).bind(group_id).bind(order).execute(pool.writer()).await.unwrap();
    }
    let snapshot = ProjectRepo::new(pool.reader().clone())
        .snapshot()
        .await
        .unwrap();
    let rows = snapshot.tree_rows();
    assert_eq!(
        rows.iter()
            .map(|row| row.label.as_str())
            .collect::<Vec<_>>(),
        ["A", "A1", "Child", "A project", "B", "Root"]
    );
    assert_eq!(
        rows.iter().map(|row| row.depth).collect::<Vec<_>>(),
        [0, 1, 2, 1, 0, 0]
    );
    assert!(rows.iter().take(2).all(|row| row.group));
    assert!(rows.iter().skip(2).any(|row| !row.group));
    let mut damaged = snapshot.clone();
    damaged
        .groups
        .iter_mut()
        .find(|group| group.id == "a")
        .unwrap()
        .parent_id = Some("a1".into());
    damaged
        .groups
        .iter_mut()
        .find(|group| group.id == "b")
        .unwrap()
        .parent_id = Some("missing".into());
    damaged
        .projects
        .iter_mut()
        .find(|project| project.id == "root-p")
        .unwrap()
        .group_id = Some("missing".into());
    let rows = damaged.tree_rows();
    assert_eq!(rows.len(), 6);
    assert_eq!(
        rows.iter()
            .map(|row| (row.group, &row.id))
            .collect::<std::collections::HashSet<_>>()
            .len(),
        6
    );
    assert!(rows.iter().any(|row| row.id == "root-p" && row.depth == 0));
    pool.close().await;
}

#[tokio::test]
async fn reads_shared_history_alias_and_starred_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let pool = DbPool::open(directory.path().join("history-meta.db"))
        .await
        .unwrap();
    run_migrations(pool.writer()).await.unwrap();
    sqlx::query(
        "INSERT INTO session_meta (session_key, session_id, source, project_key, file_path, alias, starred, tags_json, updated_at) VALUES ('claude:s:file', 's', 'claude', 'C:/project', 'C:/history/s.jsonl', 'Pinned session', 1, '[]', '2')",
    )
    .execute(pool.writer())
    .await
    .unwrap();
    let repo = ProjectRepo::new(pool.reader().clone());
    let metadata = repo.list_session_meta().await.unwrap();
    assert_eq!(metadata.len(), 1);
    assert_eq!(metadata[0].alias, "Pinned session");
    assert_eq!(metadata[0].starred, 1);
    pool.close().await;
}

#[tokio::test]
async fn aggregates_request_logs_for_project_without_writing() {
    let directory = tempfile::tempdir().unwrap();
    let pool = DbPool::open(directory.path().join("request-logs.db")).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    sqlx::query(
        "INSERT INTO request_logs (request_id, source, project_key, session_id, file_path, event_key, event_index, timestamp_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at_ms, updated_at_ms) VALUES \
        ('r1', 'claude', 'C:/project', 's', 'C:/project/a.jsonl', 'e1', 0, 1, 10, 2, 3, 4, 1, 1), \
        ('r2', 'codex', 'C:/other', 's2', 'C:/other/b.jsonl', 'e2', 0, 1, 99, 99, 99, 99, 1, 1), \
        ('r3', 'codex', 'C:/project2', 's3', 'C:/project2/c.jsonl', 'e3', 0, 1, 50, 50, 50, 50, 1, 1), \
        ('r4', 'codex', '', 's4', 'C:/project2x/d.jsonl', 'e4', 0, 1, 60, 60, 60, 60, 1, 1)"
    )
        .execute(pool.writer()).await.unwrap();
    let repo = ProjectRepo::new(pool.reader().clone());
    let summary = repo.request_log_summary("C:/project").await.unwrap();
    assert_eq!(summary.request_count, 1);
    assert_eq!(summary.input_tokens, 10);
    assert_eq!(summary.output_tokens, 2);
    assert_eq!(summary.cache_read_tokens, 3);
    assert_eq!(summary.cache_creation_tokens, 4);
    let summary_with_similar_path = repo.request_log_summary("C:/project").await.unwrap();
    assert_eq!(summary_with_similar_path.request_count, 1);
    let breakdown = repo.request_log_breakdown("C:/project").await.unwrap();
    assert_eq!(breakdown.len(), 1);
    assert_eq!(breakdown[0].source, "claude");
    assert_eq!(breakdown[0].request_count, 1);
    let entries = repo.request_log_entries("C:/project").await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].session_id, "s");
    sqlx::query("INSERT INTO usage_records (record_id, logical_request_id, data_source, source, session_id, project_key, project_path, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, usage_status, started_at_ms, duration_ms, created_at_ms, updated_at_ms) VALUES ('u1', 'u1', 'session_log', 'claude', 's', 'C:/project', 'C:/project', 10, 2, 3, 4, 'complete', 1, 120, 1, 1)")
        .execute(pool.writer()).await.unwrap();
    let efficiency = repo.project_efficiency("C:/project").await.unwrap();
    assert_eq!(efficiency.request_count, 1);
    assert_eq!(efficiency.completed_count, 1);
    assert_eq!(efficiency.total_tokens, 19);
    assert_eq!(efficiency.average_duration_ms, 120);
    let filtered = repo
        .request_log_summary_filtered(Some("C:/project"), Some("codex"), None)
        .await
        .unwrap();
    assert_eq!(filtered.request_count, 0);
    let all_projects = repo
        .request_log_summary_filtered(None, None, None)
        .await
        .unwrap();
    assert_eq!(all_projects.request_count, 4);
    let all_breakdown = repo
        .request_log_breakdown_filtered(None, None, None)
        .await
        .unwrap();
    assert_eq!(all_breakdown.iter().map(|item| item.request_count).sum::<i64>(), 4);
    pool.close().await;
}

#[tokio::test]
async fn updates_existing_history_metadata_without_creating_missing_database() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("missing-history.db");
    let patch = SessionMetaPatch {
        session_key: "claude:s:file".into(),
        session_id: "s".into(),
        source: "claude".into(),
        project_key: "C:/project".into(),
        file_path: "C:/history/s.jsonl".into(),
        alias: "Pinned session".into(),
        starred: true,
        tags_json: "[]".into(),
        updated_at: "3".into(),
    };
    assert!(update_session_meta(&missing, patch.clone()).await.is_err());
    assert!(!missing.exists());

    let path = directory.path().join("history-meta.db");
    let pool = DbPool::open(&path).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    pool.close().await;
    update_session_meta(&path, patch).await.unwrap();

    let pool = DbPool::open(&path).await.unwrap();
    let metadata = ProjectRepo::new(pool.reader().clone())
        .list_session_meta()
        .await
        .unwrap();
    assert_eq!(metadata.len(), 1);
    assert_eq!(metadata[0].alias, "Pinned session");
    assert_eq!(metadata[0].starred, 1);
    assert_eq!(metadata[0].tags_json, "[]");
    pool.close().await;
}

#[tokio::test]
async fn updates_and_deletes_history_favorite_snapshot_on_existing_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("favorite.db");
    let pool = DbPool::open(&path).await.unwrap();
    run_migrations(pool.writer()).await.unwrap();
    pool.close().await;
    upsert_favorite_snapshot(
        &path,
        FavoriteSnapshotPatch {
            session_key: "claude:s:file".into(),
            session_id: "s".into(),
            source: "claude".into(),
            project_key: "C:/project".into(),
            file_path: "C:/history/s.jsonl".into(),
            title: "Pinned".into(),
            created_at: 1,
            updated_at: 2,
            message_count: 3,
            branch: None,
            detail_json: "{\"messages\":[]}".into(),
            snapshot_at: "2".into(),
        },
    )
    .await
    .unwrap();
    let pool = DbPool::open(&path).await.unwrap();
    let row: (String, i64) = sqlx::query_as("SELECT title, message_count FROM session_favorite_snapshots WHERE session_key = 'claude:s:file'")
        .fetch_one(pool.reader()).await.unwrap();
    assert_eq!(row, ("Pinned".into(), 3));
    pool.close().await;
    delete_favorite_snapshot(&path, "claude:s:file".into())
        .await
        .unwrap();
    let pool = DbPool::open(&path).await.unwrap();
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM session_favorite_snapshots")
        .fetch_one(pool.reader())
        .await
        .unwrap();
    assert_eq!(count.0, 0);
    pool.close().await;
}
