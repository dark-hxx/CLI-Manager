use std::fs;
use super::{file_io, session_abort, session_commit, session_files, session_lifecycle,
    session_store::{self, Open, ACTIVE}, session_tests::{Fixture, git},
    session_write::{self, Action}, types::*};

#[test]
fn aborted_release_preserves_audits_and_allows_an_independent_new_round() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let terminal = session_abort::abort(&open, &stored, snapshot.revision, "abort-one").unwrap();
    assert!(crate::repo_operation::ensure_idle(&open.repo).is_err());
    let pointer = fs::read(open.identity.private_dir.join(ACTIVE)).unwrap();
    let released = session_lifecycle::release(&open, &terminal.session_id, terminal.revision, "release-one").unwrap();
    assert_eq!(released.state, State::Aborted);
    assert!(open.active().unwrap().is_none());
    assert!(crate::repo_operation::ensure_idle(&open.repo).is_ok());
    assert!(open.path(&terminal.session_id, "abort-abort-one.json").unwrap().exists());
    assert_eq!(session_lifecycle::release(&open, &terminal.session_id, terminal.revision, "release-one").unwrap().revision, released.revision);
    // 模拟写入释放收据后、删除指针前崩溃；重试仅复核和移除匹配指针。
    fs::write(open.identity.private_dir.join(ACTIVE), pointer).unwrap();
    session_lifecycle::release(&open, &terminal.session_id, terminal.revision, "release-one").unwrap();
    drop(open);
    let (head, base) = fixture.tips();
    let next = session_store::prepare(&fixture.context(), &head, &base, "prepare-next").unwrap();
    assert_ne!(next.session_id, terminal.session_id);
    let open = Open::new(&fixture.context()).unwrap();
    assert_eq!(session_lifecycle::release(&open, &terminal.session_id, terminal.revision, "release-one").unwrap_err().code, "stale");
    assert_eq!(open.active().unwrap().unwrap().manifest.snapshot.session_id, next.session_id);
}

#[test]
fn completed_release_allows_normal_finish_but_does_not_merge_the_main_checkout() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let entry = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 1).unwrap().files.remove(0);
    let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
    let ready = session_write::resolve(&open, &stored, &entry.file_id, &detail.version, snapshot.revision, Action::Side(Side::BaseBranch), "resolve-one").unwrap();
    let terminal = session_commit::continue_merge(&open, &stored, ready.revision, "Resolve target", "commit-one").unwrap();
    session_lifecycle::release(&open, &terminal.session_id, terminal.revision, "release-one").unwrap();
    assert!(crate::repo_operation::ensure_idle(&open.repo).is_ok());
    assert_eq!(git(&fixture.main, &["rev-parse", "HEAD"]), snapshot.base_oid);
    assert!(open.path(&terminal.session_id, "terminal.json").unwrap().exists());
}

#[test]
fn release_rejects_unresolved_session_or_forged_terminal_tag() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let mut stored = open.active().unwrap().unwrap();
    assert_eq!(session_lifecycle::release(&open, &snapshot.session_id, snapshot.revision, "release-one").unwrap_err().code, "stale");
    stored.manifest.snapshot.state = State::Aborted; open.save(&stored).unwrap();
    assert!(session_lifecycle::release(&open, &snapshot.session_id, snapshot.revision, "release-one").is_err());
    assert!(open.active().unwrap().is_some());
    assert!(open.repo.path().join("MERGE_HEAD").exists());
}

#[test]
fn release_rejects_pending_intents_external_changes_and_stale_revision() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let terminal = session_abort::abort(&open, &stored, snapshot.revision, "abort-one").unwrap();
    assert_eq!(session_lifecycle::release(&open, &terminal.session_id, snapshot.revision, "release-one").unwrap_err().code, "stale");
    for leaf in ["pending-write.json", "pending-commit.json", "pending-abort.json"] {
        let path = open.path(&terminal.session_id, leaf).unwrap();
        file_io::atomic(&path, b"{}").unwrap();
        assert_eq!(session_lifecycle::release(&open, &terminal.session_id, terminal.revision, "release-one").unwrap_err().code, "recovery_required");
        fs::remove_file(path).unwrap();
    }
    fs::write(fixture.worktree.join("external.txt"), b"keep me").unwrap();
    assert!(session_lifecycle::release(&open, &terminal.session_id, terminal.revision, "release-one").is_err());
    assert!(open.active().unwrap().is_some());
    assert_eq!(fs::read(fixture.worktree.join("external.txt")).unwrap(), b"keep me");
    assert!(!open.path(&terminal.session_id, "released.json").unwrap().exists());
}
