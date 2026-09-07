use super::{
    acquire_lock_with_stale_after, build_resume_args, can_reuse_published_index,
    complete_jsonl_bytes, detail_from_path, discover_files, empty_index, file_id,
    initialize_lock_dir, load_index, refresh_summaries, relative_string, remote_source_instance_id,
    remove_missing_entries, safe_transcript_ref, sync_cursor_offset, update_entry,
    validate_project_path, validate_resume_cwd, CodexThreadNameIndex, HistoryScopeRequest,
    ResolvedScope, MAX_FILE_READ_BYTES, MAX_SCAN_BYTES,
};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::Duration;

fn test_scope(root: &std::path::Path, project_paths: Vec<String>) -> ResolvedScope {
    ResolvedScope {
        source: "claude".to_string(),
        configured_root: root.to_string_lossy().to_string(),
        canonical_root: root.canonicalize().unwrap(),
        config_root_hash: "root-hash".to_string(),
        source_instance_id: "ssh-instance".to_string(),
        installation_id: "installation".to_string(),
        remote_machine_id: "machine".to_string(),
        ssh_user: "user".to_string(),
        project_paths,
        index_dir: root.join("index"),
    }
}

fn write_session(root: &std::path::Path, content: &str) -> std::path::PathBuf {
    let path = root.join("projects").join("-srv-app").join("session.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, content).unwrap();
    path.canonicalize().unwrap()
}

#[test]
fn direct_transcript_detail_reads_only_the_referenced_session() {
    let temp = tempfile::TempDir::new().unwrap();
    let target = write_session(
        temp.path(),
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-1\",\"cwd\":\"/srv/app\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"target\"}}\n",
    );
    let decoy = temp
        .path()
        .join("projects")
        .join("-srv-app")
        .join("other.jsonl");
    fs::write(
        decoy,
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-2\",\"cwd\":\"/srv/app\"}}\n",
    )
    .unwrap();
    let mut scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    scope.source = "codex".to_string();

    let relative = relative_string(&scope.canonical_root, &target).unwrap();
    let resolved = safe_transcript_ref(&scope.canonical_root, &relative).unwrap();
    let detail = detail_from_path(&scope, &resolved, "session-1", 0).unwrap();

    assert_eq!(detail.summary.session_ref.source_session_id, "session-1");
    assert_eq!(detail.messages.len(), 1);
    assert_eq!(detail.messages[0].content, "target");
}

#[test]
fn direct_transcript_ref_rejects_outside_root_and_non_jsonl_files() {
    let root = tempfile::TempDir::new().unwrap();
    #[cfg(unix)]
    {
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(
            safe_transcript_ref(
                &root.path().canonicalize().unwrap(),
                outside.path().to_str().unwrap()
            )
            .unwrap_err(),
            "history_artifact_outside_root"
        );
    }

    let text = root.path().join("session.txt");
    fs::write(&text, "{}\n").unwrap();
    assert_eq!(
        safe_transcript_ref(&root.path().canonicalize().unwrap(), "session.txt").unwrap_err(),
        "history_artifact_outside_root"
    );
}

#[test]
fn direct_transcript_detail_rejects_session_and_project_mismatches() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = write_session(
        temp.path(),
        "{\"sessionId\":\"session-1\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"},\"cwd\":\"/srv/app\"}\n",
    );
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    assert_eq!(
        detail_from_path(&scope, &path, "session-2", 0).unwrap_err(),
        "history_session_identity_mismatch"
    );

    let other_scope = test_scope(temp.path(), vec!["/srv/other".to_string()]);
    assert_eq!(
        detail_from_path(&other_scope, &path, "session-1", 0).unwrap_err(),
        "history_session_identity_mismatch"
    );
}

#[test]
fn incomplete_jsonl_tail_is_not_committed() {
    assert_eq!(complete_jsonl_bytes(b"{\"a\":1}\n{\"b\":"), b"{\"a\":1}\n");
    assert!(complete_jsonl_bytes(b"{\"a\":1}").is_empty());
}

#[test]
fn codex_thread_name_index_uses_last_valid_name() {
    let names = super::parse_codex_thread_name_index(concat!(
        r#"{"id":"session-1","thread_name":"Old name"}"#,
        "\n",
        r#"{"id":"session-1","thread_name":" New name "}"#,
        "\n",
        "broken\n",
    ));

    assert_eq!(names.get("session-1").map(String::as_str), Some("New name"));
}

#[test]
fn project_paths_are_absolute_and_confined() {
    assert_eq!(validate_project_path("/srv/app/").unwrap(), "/srv/app");
    assert!(validate_project_path("../srv/app").is_err());
    assert!(validate_project_path("/srv/../root").is_err());
}

#[test]
fn published_index_reuse_requires_complete_covered_scope() {
    let temp = tempfile::TempDir::new().unwrap();
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    let request = HistoryScopeRequest {
        source: "claude".to_string(),
        configured_config_root: scope.configured_root.clone(),
        project_paths: scope.project_paths.clone(),
        cursor: String::new(),
        limit: 21,
        force_refresh: false,
    };
    let mut index = empty_index(&scope);
    index.updated_at = 1;
    index.discovery_complete = true;
    index.partial = false;
    index.project_paths.insert("/srv/app".to_string());

    assert!(can_reuse_published_index(
        request.force_refresh,
        &request.project_paths,
        &index,
        &CodexThreadNameIndex::default(),
    ));

    let mut forced = request;
    forced.force_refresh = true;
    assert!(!can_reuse_published_index(
        forced.force_refresh,
        &forced.project_paths,
        &index,
        &CodexThreadNameIndex::default(),
    ));

    forced.force_refresh = false;
    forced.project_paths = vec!["/srv/other".to_string()];
    assert!(!can_reuse_published_index(
        forced.force_refresh,
        &forced.project_paths,
        &index,
        &CodexThreadNameIndex::default(),
    ));

    forced.project_paths = vec!["/srv/app".to_string()];
    index.partial = true;
    assert!(!can_reuse_published_index(
        forced.force_refresh,
        &forced.project_paths,
        &index,
        &CodexThreadNameIndex::default(),
    ));
}

#[test]
fn discovery_prioritizes_recent_history_files() {
    let temp = tempfile::TempDir::new().unwrap();
    let directory = temp.path().join("projects").join("-srv-app");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("older.jsonl"), "{}\n").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    fs::write(directory.join("newer.jsonl"), "{}\n").unwrap();
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);

    let discovery = discover_files(&scope);

    assert_eq!(discovery.files.len(), 2);
    assert_eq!(
        discovery.files[0]
            .path
            .file_name()
            .and_then(|name| name.to_str()),
        Some("newer.jsonl")
    );
}

#[test]
fn resume_arguments_are_structured_per_source() {
    assert_eq!(
        build_resume_args("claude", "session-1"),
        ["claude", "--resume", "session-1"]
    );
    assert_eq!(
        build_resume_args("codex", "session-2"),
        ["codex", "resume", "session-2"]
    );
}

#[test]
fn resume_cwd_rejects_relative_and_parent_paths() {
    assert_eq!(
        validate_resume_cwd("relative/path").unwrap_err(),
        "remote_session_cwd_invalid"
    );
    assert_eq!(
        validate_resume_cwd("/srv/../secret").unwrap_err(),
        "remote_session_cwd_invalid"
    );
}

#[test]
fn source_instance_identity_uses_only_stable_remote_scope_dimensions() {
    let base = remote_source_instance_id("machine", "user", "claude", "root");
    assert_eq!(
        base,
        remote_source_instance_id("machine", "user", "claude", "root")
    );
    assert_ne!(
        base,
        remote_source_instance_id("other-machine", "user", "claude", "root")
    );
    assert_ne!(
        base,
        remote_source_instance_id("machine", "other-user", "claude", "root")
    );
    assert_ne!(
        base,
        remote_source_instance_id("machine", "user", "codex", "root")
    );
    assert_ne!(
        base,
        remote_source_instance_id("machine", "user", "claude", "other-root")
    );
}

#[test]
fn file_identity_is_stable_for_same_metadata() {
    let temp = tempfile::NamedTempFile::new().unwrap();
    let metadata = temp.path().metadata().unwrap();
    assert_eq!(file_id(&metadata), file_id(&metadata));
}

#[test]
fn append_and_partial_tail_are_indexed_once_complete() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = write_session(
        temp.path(),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"one\"},\"cwd\":\"/srv/app\"}\n{\"type\":\"user\",",
    );
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    let relative = relative_string(&scope.canonical_root, &path).unwrap();
    let mut index = empty_index(&scope);
    let mut remaining = MAX_SCAN_BYTES;
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    assert_eq!(index.entries[&relative].line_count, 1);

    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"\"message\":{\"role\":\"user\",\"content\":\"two\"}}\n")
        .unwrap();
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    assert_eq!(index.entries[&relative].line_count, 2);
    assert_eq!(index.entries[&relative].parser_state.message_count, 2);
}

#[test]
fn oversized_jsonl_line_is_skipped_with_bounded_progress() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp
        .path()
        .join("projects")
        .join("-srv-app")
        .join("session.jsonl");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut oversized = vec![b'x'; MAX_FILE_READ_BYTES + 1_024];
    oversized.push(b'\n');
    fs::write(&path, oversized).unwrap();
    let path = path.canonicalize().unwrap();
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    let relative = relative_string(&scope.canonical_root, &path).unwrap();
    let mut index = empty_index(&scope);
    let mut remaining = MAX_SCAN_BYTES;

    let first = update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    assert!(!first.complete);
    assert_eq!(
        index.entries[&relative].indexed_offset,
        MAX_FILE_READ_BYTES as u64
    );
    assert!(index.entries[&relative].skipping_oversized_line);

    let second = update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    assert!(second.complete);
    assert_eq!(
        index.entries[&relative].indexed_offset,
        fs::metadata(&path).unwrap().len()
    );
    assert!(!index.entries[&relative].skipping_oversized_line);
    assert_eq!(index.entries[&relative].line_count, 0);
}

#[test]
fn truncate_rebuilds_file_generation() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = write_session(
        temp.path(),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"one\"},\"cwd\":\"/srv/app\"}\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"two\"}}\n",
    );
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    let relative = relative_string(&scope.canonical_root, &path).unwrap();
    let mut index = empty_index(&scope);
    let mut remaining = MAX_SCAN_BYTES;
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    let generation = index.entries[&relative].file_generation;

    fs::write(
        &path,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"new\"},\"cwd\":\"/srv/app\"}\n",
    )
    .unwrap();
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    assert!(index.entries[&relative].file_generation > generation);
    assert_eq!(index.entries[&relative].line_count, 1);
    assert_eq!(index.entries[&relative].parser_state.message_count, 1);
}

#[test]
fn same_size_rewrite_is_not_treated_as_append() {
    let temp = tempfile::TempDir::new().unwrap();
    let first = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"aaa\"},\"cwd\":\"/srv/app\"}\n";
    let second = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"bbb\"},\"cwd\":\"/srv/app\"}\n";
    let path = write_session(temp.path(), first);
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    let relative = relative_string(&scope.canonical_root, &path).unwrap();
    let mut index = empty_index(&scope);
    let mut remaining = MAX_SCAN_BYTES;
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(20));
    fs::write(&path, second).unwrap();
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    refresh_summaries(&scope, &mut index, &CodexThreadNameIndex::default());
    assert_eq!(
        index.entries[&relative].summary.as_ref().unwrap().title,
        "bbb"
    );
}

#[test]
fn shared_index_can_add_another_project_scope() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = write_session(
        temp.path(),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"},\"cwd\":\"/srv/app\"}\n",
    );
    let scope = test_scope(temp.path(), vec!["/srv/other".to_string()]);
    let relative = relative_string(&scope.canonical_root, &path).unwrap();
    let mut index = empty_index(&scope);
    let mut remaining = MAX_SCAN_BYTES;
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    assert!(!index.entries[&relative].in_scope);

    let expanded = vec!["/srv/other".to_string(), "/srv/app".to_string()];
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &expanded,
    )
    .unwrap();
    refresh_summaries(&scope, &mut index, &CodexThreadNameIndex::default());
    assert!(index.entries[&relative].in_scope);
    assert_eq!(
        index.entries[&relative].summary.as_ref().unwrap().title,
        "hello"
    );
}

#[test]
fn tombstones_require_complete_discovery() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = write_session(
        temp.path(),
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"session-1\",\"cwd\":\"/srv/app\"}}\n",
    );
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    let relative = relative_string(&scope.canonical_root, &path).unwrap();
    let mut index = empty_index(&scope);
    let mut remaining = MAX_SCAN_BYTES;
    update_entry(
        &scope,
        &mut index,
        &path,
        &relative,
        &mut remaining,
        &scope.project_paths,
    )
    .unwrap();
    refresh_summaries(&scope, &mut index, &CodexThreadNameIndex::default());
    assert!(remove_missing_entries(&mut index, &BTreeSet::new(), false).is_empty());
    assert!(index.entries.contains_key(&relative));
    assert_eq!(
        remove_missing_entries(&mut index, &BTreeSet::new(), true),
        vec!["session-1".to_string()]
    );
    assert!(index.entries.is_empty());
}

#[test]
fn writer_lock_keeps_live_owner_and_takes_stale_owner() {
    let temp = tempfile::TempDir::new().unwrap();
    let first = acquire_lock_with_stale_after(temp.path(), -1).unwrap();
    assert_eq!(
        acquire_lock_with_stale_after(temp.path(), -1)
            .err()
            .unwrap(),
        "history_index_busy"
    );
    drop(first);

    let lock = temp.path().join("writer.lock");
    fs::create_dir(&lock).unwrap();
    fs::write(lock.join("owner"), "0\n0").unwrap();
    let recovered = acquire_lock_with_stale_after(temp.path(), -1).unwrap();
    drop(recovered);
}

#[test]
fn failed_writer_lock_initialization_removes_lock_directory() {
    let temp = tempfile::TempDir::new().unwrap();
    let lock = temp.path().join("writer.lock");
    fs::create_dir(&lock).unwrap();
    fs::create_dir(lock.join("owner")).unwrap();

    assert_eq!(
        initialize_lock_dir(lock.clone()).err().unwrap(),
        "history_index_lock_failed"
    );
    assert!(!lock.exists());
}

#[test]
fn corrupt_index_is_rebuilt_as_derived_state() {
    let temp = tempfile::TempDir::new().unwrap();
    let scope = test_scope(temp.path(), vec!["/srv/app".to_string()]);
    fs::create_dir_all(&scope.index_dir).unwrap();
    fs::write(scope.index_dir.join("index.json"), b"{broken").unwrap();
    let index = load_index(&scope).unwrap();
    assert!(index.entries.is_empty());
    assert_eq!(
        index.schema_version,
        cli_manager_history_core::INDEX_SCHEMA_VERSION
    );
}

#[test]
fn sync_cursor_resets_when_generation_changes() {
    assert_eq!(sync_cursor_offset("7:40", 7), 40);
    assert_eq!(sync_cursor_offset("7:40", 8), 0);
    assert_eq!(sync_cursor_offset("broken", 7), 0);
}
