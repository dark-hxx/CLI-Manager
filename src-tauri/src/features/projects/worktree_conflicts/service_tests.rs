use std::fs;
use super::{conflict_commands as commands, file_io, session_service::{self, Probe}, session_store::{Open, ACTIVE}, session_tests::{git, Fixture}, types::*};

#[test]
fn probe_does_not_read_file_pages_or_write_progress_and_recheck_preserves_original_collection() {
    let fixture = Fixture::new(2);
    let (head, base) = fixture.tips();
    assert!(matches!(session_service::probe(&fixture.context()).unwrap(), Probe::None { head_oid, base_oid } if head_oid == head && base_oid == base));
    let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap();
    let manifest = open.path(&snapshot.session_id, "manifest.json").unwrap();
    let page = open.path(&snapshot.session_id, "files-0.json").unwrap();
    let manifest_hash = file_io::fingerprint(&manifest).unwrap();
    let original = fs::read(&page).unwrap(); fs::write(&page, b"invalid page").unwrap(); drop(open);
    assert!(matches!(session_service::probe(&fixture.context()).unwrap(), Probe::Managed { snapshot: found } if found.session_id == snapshot.session_id));
    assert_eq!(file_io::fingerprint(&manifest).unwrap(), manifest_hash);
    fs::write(&page, original).unwrap();
    let open = Open::new(&fixture.context()).unwrap();
    let checked = session_service::recheck(&open, &snapshot.session_id).unwrap();
    assert_eq!(checked.total, 2); assert_eq!(checked.revision, snapshot.revision);
}

#[test]
fn unknown_intents_and_foreign_operations_are_never_adopted_or_replayed() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap();
    let pending = open.path(&snapshot.session_id, "pending-write.json").unwrap();
    fs::write(&pending, b"{}").unwrap();
    let index = file_io::fingerprint(&open.repo.path().join("index")).unwrap(); drop(open);
    assert!(matches!(session_service::probe(&fixture.context()).unwrap(), Probe::Recovery { snapshot: Some(_), .. }));
    let open = Open::new(&fixture.context()).unwrap();
    assert!(session_service::recheck(&open, &snapshot.session_id).is_err());
    assert_eq!(file_io::fingerprint(&open.repo.path().join("index")).unwrap(), index);
    fs::remove_file(pending).unwrap(); fs::remove_file(open.identity.private_dir.join(ACTIVE)).unwrap(); drop(open);
    assert!(matches!(session_service::probe(&fixture.context()).unwrap(), Probe::Foreign { .. }));
    assert!(Open::new(&fixture.context()).unwrap().repo.path().join("MERGE_HEAD").exists());
}

#[tokio::test]
async fn command_flow_preserves_paging_epoch_cas_and_explicit_terminal_acknowledgement() {
    let fixture = Fixture::new(1); let (head, base) = fixture.tips();
    let snapshot = commands::git_worktree_prepare_conflicts(fixture.context(), head.clone(), base.clone(), "prepare-ipc".into()).await.unwrap();
    assert!(commands::git_worktree_conflict_status(fixture.context(), "wrong-session".into(), snapshot.list_snapshot_id.clone(), 0, 200).await.is_err());
    assert!(commands::git_worktree_conflict_status(fixture.context(), snapshot.session_id.clone(), snapshot.list_snapshot_id.clone(), 0, 201).await.is_err());
    let page = commands::git_worktree_conflict_status(fixture.context(), snapshot.session_id.clone(), snapshot.list_snapshot_id.clone(), 0, 200).await.unwrap();
    let file = page.files[0].file_id.clone();
    let response = commands::git_worktree_conflict_file(fixture.context(), snapshot.session_id.clone(), file.clone(), 19).await.unwrap();
    assert_eq!(response.request_epoch, 19); assert_eq!(response.detail.capability, "blocks");
    let ready = commands::git_worktree_take_conflict_side(fixture.context(), snapshot.session_id.clone(), file, response.detail.version, snapshot.revision, Side::BaseBranch, "side-ipc".into()).await.unwrap();
    assert_eq!(ready.state, State::Ready);
    assert!(matches!(commands::git_worktree_probe_conflicts(fixture.context()).await.unwrap(), Probe::Managed { snapshot: found } if found.state == State::Ready));
    let complete = commands::git_worktree_continue_conflicts(fixture.context(), snapshot.session_id.clone(), ready.revision, "merge target".into(), "continue-ipc".into()).await.unwrap();
    assert_eq!(complete.state, State::Completed);
    assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD^1"]), head);
    assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD^2"]), base);
    assert!(matches!(commands::git_worktree_probe_conflicts(fixture.context()).await.unwrap(), Probe::Managed { .. }));
    commands::git_worktree_release_conflicts(fixture.context(), snapshot.session_id.clone(), complete.revision, "release-ipc".into()).await.unwrap();
    commands::git_worktree_release_conflicts(fixture.context(), snapshot.session_id, complete.revision, "release-ipc".into()).await.unwrap();
    assert!(matches!(commands::git_worktree_probe_conflicts(fixture.context()).await.unwrap(), Probe::None { .. }));
}

#[tokio::test]
async fn command_abort_rechecks_and_releases_without_deleting_worktree() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let aborted = commands::git_worktree_abort_conflicts(fixture.context(), snapshot.session_id.clone(), snapshot.revision, "abort-ipc".into()).await.unwrap();
    assert_eq!(aborted.state, State::Aborted);
    let checked = commands::git_worktree_recheck_conflicts(fixture.context(), snapshot.session_id.clone()).await.unwrap();
    assert_eq!(checked.revision, aborted.revision);
    commands::git_worktree_release_conflicts(fixture.context(), snapshot.session_id, aborted.revision, "ack-abort".into()).await.unwrap();
    assert!(fixture.worktree.is_dir()); assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD"]), snapshot.head_oid);
}
