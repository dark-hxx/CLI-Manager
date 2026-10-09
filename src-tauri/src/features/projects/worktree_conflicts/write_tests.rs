use std::fs;
use super::{session_files, session_index, session_store::{self, Open, Stored},
    session_tests::{Fixture, git}, session_write::{self, Action}, types::*};

fn first(open: &Open, stored: &Stored) -> FileEntry {
    session_store::page(open, stored, &stored.manifest.snapshot.list_snapshot_id, 0, 200).unwrap().files[0].clone()
}

fn choose(open: &Open, stored: &Stored, entry: &FileEntry, selection: Selection) -> Detail {
    let detail = session_files::detail(open, stored, &entry.file_id).unwrap();
    let choices = detail.blocks.iter().map(|b| (b.id.clone(), selection.clone())).collect();
    session_files::save_draft(open, stored, &entry.file_id, &detail.version, detail.draft.revision, choices, "save-choice").unwrap();
    session_files::detail(open, stored, &entry.file_id).unwrap()
}

#[test]
fn finalizing_saved_blocks_stages_exact_result_and_retries_idempotently() {
    let fixture = Fixture::new(2); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    let other = fs::read(fixture.worktree.join("file-0001.txt")).unwrap();
    let detail = choose(&open, &stored, &entry, Selection::Both);
    let action = Action::Draft { revision: detail.draft.revision };
    let result = session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, action.clone(), "resolve-test").unwrap();
    assert_eq!(result.resolved, 1); assert_eq!(result.unresolved, 1); assert_eq!(result.state, State::Resolving);
    assert_eq!(fs::read(fixture.worktree.join(&entry.display_path)).unwrap(), b"base branch\nworktree\n");
    assert_eq!(fs::read(fixture.worktree.join("file-0001.txt")).unwrap(), other);
    assert_eq!(git(&fixture.worktree, &["show", &format!(":{}", entry.display_path)]), "base branch\nworktree");
    let again = session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, action, "resolve-test").unwrap();
    assert_eq!(again.revision, result.revision);
    assert_eq!(session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Side(Side::Worktree), "resolve-test").unwrap_err().code, "stale");
    assert_eq!(git(&fixture.main, &["status", "--porcelain"]), "");
}

#[test]
fn partial_or_stale_draft_never_writes_work_or_index() {
    let fixture = Fixture::new(1); fixture.prepare(); let open = Open::new(&fixture.context()).unwrap();
    let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
    let before = fs::read(fixture.worktree.join(&entry.display_path)).unwrap();
    assert_eq!(session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Draft { revision: 0 }, "partial-test").unwrap_err().code, "unresolved");
    choose(&open, &stored, &entry, Selection::BaseBranch);
    assert_eq!(session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Draft { revision: 0 }, "stale-test").unwrap_err().code, "stale");
    assert_eq!(fs::read(fixture.worktree.join(&entry.display_path)).unwrap(), before);
    assert_eq!(session_index::validate(&open, &stored, false).unwrap().unresolved, 1);
    session_write::ensure_no_pending(&open, &stored).unwrap();
}

#[test]
fn whole_side_uses_stage_three_for_base_and_stage_two_for_worktree() {
    let fixture = Fixture::new(2); fixture.prepare(); let open = Open::new(&fixture.context()).unwrap();
    for (offset, side, expected) in [(0, Side::BaseBranch, b"base branch\n".as_slice()), (1, Side::Worktree, b"worktree\n".as_slice())] {
        let stored = open.active().unwrap().unwrap();
        let entry = session_store::page(&open, &stored, &stored.manifest.snapshot.list_snapshot_id, offset, 1).unwrap().files[0].clone();
        let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
        session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Side(side), &format!("side-{offset}")).unwrap();
        assert_eq!(fs::read(fixture.worktree.join(&entry.display_path)).unwrap(), expected);
    }
    let stored = open.active().unwrap().unwrap();
    assert_eq!(stored.manifest.snapshot.state, State::Ready); assert_eq!(stored.manifest.snapshot.resolved, 2);
    assert_eq!(session_index::validate(&open, &stored, true).unwrap().unresolved, 0);
}

#[test]
fn selecting_deleted_side_removes_only_that_conflict() {
    let fixture = Fixture::new(1);
    git(&fixture.main, &["rm", "file-0000.txt"]); git(&fixture.main, &["commit", "-m", "delete on base"]);
    fixture.prepare(); let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap(); assert!(!detail.base_exists);
    let result = session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Side(Side::BaseBranch), "delete-test").unwrap();
    assert_eq!(result.state, State::Ready); assert!(!fixture.worktree.join(&entry.display_path).exists());
    assert!(!session_store::index_state(&open.repo).unwrap().contains_key(&entry.display_path));
    session_index::validate(&open, &open.active().unwrap().unwrap(), true).unwrap();
}

#[test]
fn receipt_loss_recovers_from_intent_without_rewriting_files() {
    let fixture = Fixture::new(1); fixture.prepare(); let context = fixture.context(); let open = Open::new(&context).unwrap();
    let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored); let detail = choose(&open, &stored, &entry, Selection::Worktree);
    let result = session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Draft { revision: detail.draft.revision }, "lost-response").unwrap();
    let audit = open.path(&result.session_id, "write-lost-response.json").unwrap();
    fs::copy(audit, open.path(&result.session_id, "pending-write.json").unwrap()).unwrap();
    fs::remove_file(open.path(&result.session_id, &format!("receipt-{}.json", entry.file_id)).unwrap()).unwrap();
    open.save(&stored).unwrap(); drop(open);
    let before = fs::read(fixture.worktree.join(&entry.display_path)).unwrap();
    let open = Open::new(&context).unwrap(); let restored = open.active().unwrap().unwrap();
    let result = session_write::reconcile(&open, &restored).unwrap();
    assert_eq!(result.state, State::Ready); assert_eq!(result.resolved, 1);
    assert_eq!(fs::read(fixture.worktree.join(&entry.display_path)).unwrap(), before);
    session_write::ensure_no_pending(&open, &restored).unwrap();
}

#[test]
fn recovery_refuses_unknown_edits_and_preserves_pending_intent() {
    let fixture = Fixture::new(1); fixture.prepare(); let open = Open::new(&fixture.context()).unwrap();
    let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored); let detail = choose(&open, &stored, &entry, Selection::BaseBranch);
    session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Draft { revision: detail.draft.revision }, "external-change").unwrap();
    fs::copy(open.path(&stored.manifest.snapshot.session_id, "write-external-change.json").unwrap(), open.path(&stored.manifest.snapshot.session_id, "pending-write.json").unwrap()).unwrap();
    fs::write(fixture.worktree.join(&entry.display_path), b"external edit").unwrap();
    let updated = open.active().unwrap().unwrap();
    assert_eq!(session_write::reconcile(&open, &updated).unwrap_err().code, "recovery_required");
    assert_eq!(fs::read(fixture.worktree.join(&entry.display_path)).unwrap(), b"external edit");
    assert_eq!(session_write::ensure_no_pending(&open, &updated).unwrap_err().code, "recovery_required");
}

#[test]
fn unrelated_staging_or_session_revision_change_rejects_before_intent() {
    let fixture = Fixture::new(1); fixture.prepare(); let open = Open::new(&fixture.context()).unwrap();
    let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored); let detail = choose(&open, &stored, &entry, Selection::BaseBranch);
    let action = Action::Draft { revision: detail.draft.revision };
    assert_eq!(session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision + 1, action.clone(), "wrong-revision").unwrap_err().code, "stale");
    fs::write(fixture.worktree.join("unrelated"), b"user file").unwrap(); git(&fixture.worktree, &["add", "unrelated"]);
    assert_eq!(session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, action, "unknown-stage").unwrap_err().code, "stale");
    session_write::ensure_no_pending(&open, &stored).unwrap();
    assert!(fs::read_to_string(fixture.worktree.join(&entry.display_path)).unwrap().contains("<<<<<<<"));
}

#[test]
fn binary_whole_file_and_executable_mode_are_preserved() {
    let fixture = Fixture::new(1);
    fs::write(fixture.main.join("file-0000.txt"), b"base\0binary").unwrap();
    git(&fixture.main, &["add", "file-0000.txt"]); git(&fixture.main, &["update-index", "--chmod=+x", "file-0000.txt"]);
    git(&fixture.main, &["commit", "-m", "binary executable"]);
    fs::write(fixture.worktree.join("file-0000.txt"), b"worktree\0binary").unwrap(); git(&fixture.worktree, &["commit", "-am", "binary task"]);
    fixture.prepare(); let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap(); assert_eq!(detail.capability, "whole_file");
    session_write::resolve(&open, &stored, &entry.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Side(Side::BaseBranch), "binary-side").unwrap();
    assert_eq!(fs::read(fixture.worktree.join(&entry.display_path)).unwrap(), b"base\0binary");
    assert_eq!(session_store::index_state(&open.repo).unwrap()[&entry.display_path][0].mode, 0o100755);
}
