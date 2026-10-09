use std::{collections::BTreeMap, fs};
use super::{file_io, session_abort, session_commit, session_files, session_store::{self, Open}, session_write::{self, Action},
    session_tests::{git, Fixture}, types::*};

#[test]
fn abort_unopened_conflicts_restores_head_and_preserves_main_and_ignored_files() {
    let fixture = Fixture::new(2);
    git(&fixture.worktree, &["config", "core.excludesFile", "ignored-patterns"]);
    fs::write(fixture.worktree.join("ignored-patterns"), b"ignored-patterns\nignored-data\n").unwrap();
    fs::write(fixture.worktree.join("ignored-data"), b"keep").unwrap();
    let snapshot = fixture.prepare();
    let main_head = git(&fixture.main, &["rev-parse", "HEAD"]);
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    assert!(stored.initial_work_tree.is_some());
    let result = session_abort::abort(&open, &stored, snapshot.revision, "abort-test").unwrap();
    assert_eq!(result.state, State::Aborted);
    assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD"]), snapshot.head_oid);
    assert!(git(&fixture.worktree, &["status", "--porcelain"]).is_empty());
    assert_eq!(fs::read(fixture.worktree.join("file-0000.txt")).unwrap(), b"worktree\n");
    assert_eq!(fs::read(fixture.worktree.join("ignored-data")).unwrap(), b"keep");
    assert_eq!(git(&fixture.main, &["rev-parse", "HEAD"]), main_head);
    assert_eq!(session_abort::abort(&open, &stored, snapshot.revision, "abort-test").unwrap().revision, result.revision);
    assert_eq!(session_abort::abort(&open, &stored, snapshot.revision + 1, "abort-test").unwrap_err().code, "stale");
}

#[test]
fn abort_accepts_only_known_resolution_writes_and_leaves_saved_draft_audit() {
    let fixture = Fixture::new(2); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let page = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 2).unwrap();
    let first = &page.files[0]; let second = &page.files[1];
    let detail = session_files::detail(&open, &stored, &second.file_id).unwrap();
    let choices = BTreeMap::from([(detail.blocks[0].id.clone(), Selection::Both)]);
    session_files::save_draft(&open, &stored, &second.file_id, &detail.version, detail.draft.revision, choices, "draft-test").unwrap();
    let detail = session_files::detail(&open, &stored, &first.file_id).unwrap();
    session_write::resolve(&open, &stored, &first.file_id, &detail.version, snapshot.revision, Action::Side(Side::BaseBranch), "resolve-test").unwrap();
    // 调用者仍持旧 Stored；分页必须读新 manifest，但原始列表 ID、排序和数量不变。
    let refreshed = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 2).unwrap();
    assert!(refreshed.files[0].resolved); assert!(!refreshed.files[1].resolved);
    assert_eq!(refreshed.snapshot.total, 2); assert_eq!(refreshed.snapshot.resolved, 1);
    let result = session_abort::abort(&open, &stored, refreshed.snapshot.revision, "abort-test").unwrap();
    assert_eq!(result.state, State::Aborted);
    assert!(open.path(&snapshot.session_id, &format!("draft-{}.json", second.file_id)).unwrap().exists());
    assert!(git(&fixture.worktree, &["status", "--porcelain"]).is_empty());
}

#[test]
fn abort_rejects_external_edit_before_first_detail_without_overwriting_it() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    fs::write(fixture.worktree.join("file-0000.txt"), b"external edit before opening UI\n").unwrap();
    assert_eq!(session_abort::abort(&open, &stored, snapshot.revision, "abort-test").unwrap_err().code, "stale");
    assert_eq!(fs::read(fixture.worktree.join("file-0000.txt")).unwrap(), b"external edit before opening UI\n");
    assert!(open.repo.path().join("MERGE_HEAD").exists());
    assert!(!open.path(&snapshot.session_id, "pending-abort.json").unwrap().exists());
}

#[test]
fn abort_rejects_untracked_file_and_unrelated_index_change() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    fs::write(fixture.worktree.join("outside.txt"), b"preserve").unwrap();
    assert_eq!(session_abort::abort(&open, &stored, snapshot.revision, "untracked").unwrap_err().code, "stale");
    git(&fixture.worktree, &["add", "outside.txt"]);
    assert_eq!(session_abort::abort(&open, &stored, snapshot.revision, "staged").unwrap_err().code, "stale");
    assert_eq!(fs::read(fixture.worktree.join("outside.txt")).unwrap(), b"preserve");
    assert!(open.repo.index().unwrap().get_path(std::path::Path::new("outside.txt"), 0).is_some());
}

#[test]
fn abort_missing_original_tree_fails_closed_and_preserves_merge() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let mut stored = open.active().unwrap().unwrap();
    stored.initial_work_tree = None; open.save(&stored).unwrap();
    assert_eq!(session_abort::abort(&open, &stored, snapshot.revision, "abort-test").unwrap_err().code, "unsupported");
    assert!(open.repo.path().join("MERGE_HEAD").exists());
}

#[test]
fn abort_response_loss_is_reconciled_without_replaying_git() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    session_abort::abort(&open, &stored, snapshot.revision, "abort-test").unwrap();
    let audit_path = open.path(&snapshot.session_id, "abort-abort-test.json").unwrap();
    let audit: serde_json::Value = file_io::read_json(&audit_path).unwrap();
    file_io::write_json(&open.path(&snapshot.session_id, "pending-abort.json").unwrap(), &audit["intent"]).unwrap();
    fs::remove_file(audit_path).unwrap();
    let mut stored = open.load(&snapshot.session_id).unwrap(); stored.manifest.snapshot.state = State::Aborting; open.save(&stored).unwrap();
    drop(open);
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    assert_eq!(session_abort::abort(&open, &stored, snapshot.revision, "abort-test").unwrap().state, State::Aborted);
    assert!(git(&fixture.worktree, &["status", "--porcelain"]).is_empty());
}

#[test]
fn pending_commit_blocks_file_resolution_even_before_manifest_state_save() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let page = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 1).unwrap();
    let id = &page.files[0].file_id; let detail = session_files::detail(&open, &stored, id).unwrap();
    fs::write(open.path(&snapshot.session_id, "pending-commit.json").unwrap(), b"{}").unwrap();
    assert_eq!(session_write::resolve(&open, &stored, id, &detail.version, snapshot.revision, Action::Side(Side::BaseBranch), "resolve-test").unwrap_err().code, "recovery_required");
    assert!(open.repo.index().unwrap().has_conflicts());
    assert!(!open.path(&snapshot.session_id, "pending-write.json").unwrap().exists());
}

#[test]
fn pending_abort_blocks_all_other_writes_even_before_manifest_state_save() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let page = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 1).unwrap();
    let id = &page.files[0].file_id;
    let detail = session_files::detail(&open, &stored, id).unwrap();
    let before_index = session_store::index_state(&open.repo).unwrap();
    let before_work = fs::read(fixture.worktree.join("file-0000.txt")).unwrap();
    fs::write(open.path(&snapshot.session_id, "pending-abort.json").unwrap(), b"{}").unwrap();
    assert_eq!(session_files::save_draft(&open, &stored, id, &detail.version, 0, BTreeMap::new(), "save").unwrap_err().code, "recovery_required");
    assert_eq!(session_write::resolve(&open, &stored, id, &detail.version, snapshot.revision, Action::Side(Side::BaseBranch), "resolve").unwrap_err().code, "recovery_required");
    assert_eq!(session_write::reconcile(&open, &stored).unwrap_err().code, "recovery_required");
    assert_eq!(session_commit::continue_merge(&open, &stored, snapshot.revision, "merge", "commit").unwrap_err().code, "recovery_required");
    assert_eq!(session_store::index_state(&open.repo).unwrap(), before_index);
    assert_eq!(fs::read(fixture.worktree.join("file-0000.txt")).unwrap(), before_work);
}
