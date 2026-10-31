use std::fs;
use super::{file_io, session_files, session_prepare, session_store::{self, Open, Stored}, session_tests::{git, Fixture}, types::*};

fn interrupted(open: &Open) -> Stored {
    let mut stored = open.active().unwrap().unwrap();
    stored.manifest.snapshot.state = State::Preparing; stored.manifest.snapshot.revision = 1;
    stored.manifest.snapshot.total = 0; stored.manifest.snapshot.unresolved = 0;
    stored.index_pages = 0; stored.index_hash = None; stored.initial_work_tree = None;
    open.save(&stored).unwrap(); stored
}

#[test]
fn checkpoint_restores_preparation_after_manifest_response_loss_without_git_writes() {
    let fixture = Fixture::new(2); let original = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); interrupted(&open);
    let index = file_io::fingerprint(&open.repo.path().join("index")).unwrap();
    let work = fs::read(fixture.worktree.join("file-0000.txt")).unwrap(); drop(open);
    let recovered = session_store::prepare(&fixture.context(), &original.head_oid, &original.base_oid, "prepare-test").unwrap();
    assert_eq!(recovered.state, State::Resolving); assert_eq!(recovered.revision, 2);
    assert_eq!(recovered.session_id, original.session_id); assert_eq!(recovered.total, 2);
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    assert_eq!(file_io::fingerprint(&open.repo.path().join("index")).unwrap(), index);
    assert_eq!(fs::read(fixture.worktree.join("file-0000.txt")).unwrap(), work);
    let page = session_store::page(&open, &stored, &recovered.list_snapshot_id, 0, 200).unwrap();
    assert_eq!(page.files.len(), 2);
    assert_eq!(session_files::detail(&open, &stored, &page.files[0].file_id).unwrap().capability, "blocks");
}

#[test]
fn missing_checkpoint_never_claims_a_merge_using_only_merge_head() {
    let fixture = Fixture::new(1); fixture.prepare(); let open = Open::new(&fixture.context()).unwrap();
    let stored = interrupted(&open);
    fs::remove_file(open.path(&stored.manifest.snapshot.session_id, "prepared.json").unwrap()).unwrap();
    let before = session_store::index_state(&open.repo).unwrap();
    assert_eq!(session_prepare::reconcile(&open, &stored).unwrap_err().code, "recovery_required");
    assert_eq!(session_store::index_state(&open.repo).unwrap(), before);
    assert!(open.repo.path().join("MERGE_HEAD").exists());
    assert_eq!(open.active().unwrap().unwrap().manifest.snapshot.state, State::Preparing);
}

#[test]
fn checkpoint_recovery_rejects_changed_metadata_work_and_index_without_adopting_them() {
    let fixture = Fixture::new(1); fixture.prepare(); let open = Open::new(&fixture.context()).unwrap();
    let stored = interrupted(&open);
    let page = open.path(&stored.manifest.snapshot.session_id, "files-0.json").unwrap();
    let metadata = fs::read(&page).unwrap(); fs::write(&page, b"[]").unwrap();
    assert_eq!(session_prepare::reconcile(&open, &stored).unwrap_err().code, "recovery_required");
    fs::write(&page, metadata).unwrap();
    let path = fixture.worktree.join("file-0000.txt");
    let original = fs::read(&path).unwrap(); fs::write(&path, b"external edit").unwrap();
    assert_eq!(session_prepare::reconcile(&open, &stored).unwrap_err().code, "stale");
    assert_eq!(fs::read(&path).unwrap(), b"external edit"); fs::write(&path, original).unwrap();
    git(&fixture.worktree, &["add", "file-0000.txt"]);
    let index = session_store::index_state(&open.repo).unwrap();
    assert_eq!(session_prepare::reconcile(&open, &stored).unwrap_err().code, "stale");
    assert_eq!(session_store::index_state(&open.repo).unwrap(), index);
    assert_eq!(open.active().unwrap().unwrap().manifest.snapshot.state, State::Preparing);
}

#[test]
fn rename_rename_groups_are_external_only_including_the_missing_original_path() {
    let fixture = Fixture::new(1);
    for (root, destination) in [(&fixture.main, "base-name.txt"), (&fixture.worktree, "worktree-name.txt")] {
        fs::write(root.join("file-0000.txt"), b"ancestor\n").unwrap();
        git(root, &["mv", "file-0000.txt", destination]); git(root, &["commit", "-am", "rename the same ancestor"]);
    }
    let snapshot = fixture.prepare(); let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let page = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 200).unwrap();
    assert_eq!(page.files.len(), 3);
    for entry in page.files {
        assert_eq!(entry.capability, "external_only"); assert_eq!(entry.reason.as_deref(), Some("possible_rename_group"));
        assert!(session_files::detail(&open, &stored, &entry.file_id).unwrap().source.is_none());
    }
}

#[test]
fn rename_over_an_existing_path_is_not_misclassified_as_independent_modify_delete() {
    let fixture = Fixture::new(2);
    git(&fixture.worktree, &["mv", "-f", "file-0000.txt", "file-0001.txt"]);
    git(&fixture.worktree, &["commit", "-am", "rename over existing destination"]);
    let snapshot = fixture.prepare(); let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let page = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 200).unwrap();
    assert!(!page.files.is_empty()); assert!(page.files.iter().all(|entry| entry.capability == "external_only"));
}
