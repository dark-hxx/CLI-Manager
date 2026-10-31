use std::{collections::BTreeMap, fs};
use super::{file_io, parser, session_files, session_store::{self, Open}, session_tests::{Fixture, git}, types::*};

fn first(open: &Open, stored: &session_store::Stored) -> FileEntry {
    session_store::page(open, stored, &stored.manifest.snapshot.list_snapshot_id, 0, 200).unwrap().files.remove(0)
}

#[test]
fn file_index_lookup_matches_full_state_and_observes_external_index_updates() {
    let fixture = Fixture::new(2); fixture.prepare();
    let repo = git2::Repository::open(&fixture.worktree).unwrap();
    let path = "file-0000.txt";
    let full = session_store::index_state(&repo).unwrap();
    assert_eq!(session_store::file_index_state(&repo, path).unwrap(), full[path]);
    assert_eq!(full[path].iter().map(|s| s.stage).collect::<Vec<_>>(), [1, 2, 3]);
    assert!(session_store::file_index_state(&repo, "missing.txt").unwrap().is_empty());
    assert_eq!(session_store::file_index_state(&repo, "bad\0path").unwrap_err().code, "invalid_path");

    git(&fixture.worktree, &["checkout", "--ours", "--", path]);
    git(&fixture.worktree, &["add", "--", path]);
    let staged = session_store::file_index_state(&repo, path).unwrap();
    assert_eq!(staged, session_store::index_state(&repo).unwrap()[path]);
    assert_eq!(staged.iter().map(|s| s.stage).collect::<Vec<_>>(), [0]);
    git(&fixture.worktree, &["rm", "-f", "--", path]);
    assert!(session_store::file_index_state(&repo, path).unwrap().is_empty());

    let unicode = "路径 空格.txt";
    fs::write(fixture.worktree.join(unicode), b"new stage zero\n").unwrap();
    git(&fixture.worktree, &["add", "--", unicode]);
    assert_eq!(session_store::file_index_state(&repo, unicode).unwrap(), session_store::index_state(&repo).unwrap()[unicode]);
    fs::write(fixture.worktree.join(unicode), b"updated externally\n").unwrap();
    git(&fixture.worktree, &["add", "--", unicode]);
    assert_eq!(session_store::file_index_state(&repo, unicode).unwrap(), session_store::index_state(&repo).unwrap()[unicode]);
}

#[test]
fn details_are_lazy_and_keep_base_left_worktree_right() {
    let fixture = Fixture::new(2); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let page = session_store::page(&open, &stored, &stored.manifest.snapshot.list_snapshot_id, 0, 200).unwrap();
    let detail = session_files::detail(&open, &stored, &page.files[0].file_id).unwrap();
    assert_eq!(detail.capability, "blocks"); assert_eq!(detail.blocks.len(), 1);
    assert_eq!(detail.blocks[0].base.trim(), "base branch");
    assert_eq!(detail.blocks[0].worktree.trim(), "worktree");
    assert_eq!(detail.blocks[0].ancestor.as_deref().unwrap().trim(), "ancestor");
    assert_eq!(detail.draft.revision, 0);
    let session = &stored.manifest.snapshot.session_id;
    assert!(open.path(session, &format!("source-{}.json", page.files[0].file_id)).unwrap().exists());
    assert!(!open.path(session, &format!("source-{}.json", page.files[1].file_id)).unwrap().exists());
    assert_eq!(session_files::detail(&open, &stored, &detail.file_id).unwrap().version, detail.version);
}

#[test]
fn draft_save_is_atomic_idempotent_and_does_not_stage_or_write_work_file() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare(); let context = fixture.context();
    let open = Open::new(&context).unwrap(); let stored = open.active().unwrap().unwrap();
    let entry = first(&open, &stored); let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
    let work = fs::read(fixture.worktree.join(&entry.display_path)).unwrap();
    let index = session_store::index_state(&open.repo).unwrap();
    let choices = BTreeMap::from([(detail.blocks[0].id.clone(), Selection::BaseBranch)]);
    let saved = session_files::save_draft(&open, &stored, &entry.file_id, &detail.version, 0, choices.clone(), "draft-one").unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(session_files::save_draft(&open, &stored, &entry.file_id, &detail.version, 0, choices.clone(), "draft-one").unwrap().revision, 1);
    assert_eq!(session_files::save_draft(&open, &stored, &entry.file_id, &detail.version, 0, BTreeMap::new(), "draft-one").unwrap_err().code, "stale");
    assert_eq!(session_files::save_draft(&open, &stored, &entry.file_id, &detail.version, 0, choices.clone(), "draft-two").unwrap_err().code, "stale");
    assert_eq!(fs::read(fixture.worktree.join(&entry.display_path)).unwrap(), work);
    assert_eq!(session_store::index_state(&open.repo).unwrap(), index);
    drop(open);
    let open = Open::new(&context).unwrap(); let stored = open.active().unwrap().unwrap();
    let restored = session_files::detail(&open, &stored, &entry.file_id).unwrap();
    assert_eq!(restored.draft.choices, choices); assert_eq!(restored.draft.revision, 1);
    assert_ne!(restored.version, detail.version);
    assert_eq!(stored.manifest.snapshot.list_snapshot_id, snapshot.list_snapshot_id);
    assert_eq!(session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 200).unwrap().files[0].resolved, false);
}

#[test]
fn stale_source_and_stage_all_cannot_be_saved_as_a_draft() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let entry = first(&open, &stored); let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
    let path = fixture.worktree.join(&entry.display_path); let original = fs::read(&path).unwrap();
    fs::write(&path, b"external edit").unwrap();
    assert_eq!(session_files::save_draft(&open, &stored, &entry.file_id, &detail.version, 0, BTreeMap::new(), "stale-source").unwrap_err().code, "stale");
    fs::write(&path, original).unwrap(); git(&fixture.worktree, &["add", "."]);
    assert_eq!(session_files::detail(&open, &stored, &entry.file_id).unwrap_err().code, "stale");
}

#[test]
fn unknown_blocks_and_invalid_edits_are_rejected_without_draft_files() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let entry = first(&open, &stored); let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
    for (id, selection, error) in [("invented".into(), Selection::Both, "invalid_draft"),
        (detail.blocks[0].id.clone(), Selection::Edited(String::from(char::from(0))), "limit_exceeded"),
        (detail.blocks[0].id.clone(), Selection::Edited("x".repeat(parser::MAX_LINE_BYTES + 1)), "limit_exceeded")] {
        assert_eq!(session_files::save_draft(&open, &stored, &entry.file_id, &detail.version, 0, BTreeMap::from([(id, selection)]), "invalid").unwrap_err().code, error);
    }
    assert!(!open.path(&stored.manifest.snapshot.session_id, &format!("draft-{}.json", entry.file_id)).unwrap().exists());
}

#[test]
fn custom_marker_size_is_read_from_git_attributes() {
    let fixture = Fixture::new(1);
    let main = git2::Repository::open(&fixture.main).unwrap();
    fs::write(main.path().join("info/attributes"), b"*.txt conflict-marker-size=11").unwrap();
    fixture.prepare(); let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let detail = session_files::detail(&open, &stored, &first(&open, &stored).file_id).unwrap();
    assert_eq!(detail.marker_size, 11); assert_eq!(detail.capability, "blocks");
    assert!(detail.source.as_ref().unwrap().starts_with(&"<".repeat(11)));
}

#[test]
fn unsupported_content_returns_only_bounded_fallback_metadata() {
    for (content, reason) in [(vec![0, 1, 2], "binary"), (vec![0xff, 0xfe], "encoding"),
        (vec![b'x'; parser::MAX_SOURCE_BYTES + 1], "too_large")] {
        let fixture = Fixture::new(1);
        fs::write(fixture.worktree.join("file-0000.txt"), content).unwrap();
        git(&fixture.worktree, &["commit", "-am", "unsupported worktree content"]);
        fixture.prepare();
        let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
        let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
        assert_eq!(detail.capability, "whole_file"); assert_eq!(detail.reason.as_deref(), Some(reason));
        assert!(detail.source.is_none()); assert!(detail.blocks.is_empty());
        assert!(serde_json::to_vec(&detail).unwrap().len() < 1024);
    }
}

#[test]
fn json_expansion_downgrades_before_persisting_source() {
    let fixture = Fixture::new(1);
    let lf = char::from(10); let line = String::from(char::from(1)).repeat(50_000);
    let body = format!("{line}{lf}").repeat(18);
    fs::write(fixture.worktree.join("file-0000.txt"), body).unwrap();
    git(&fixture.worktree, &["commit", "-am", "large escaped text"]);
    fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
    assert_eq!(detail.reason.as_deref(), Some("json_limit")); assert!(detail.source.is_none());
    assert!(!open.path(&stored.manifest.snapshot.session_id, &format!("source-{}.json", entry.file_id)).unwrap().exists());
}

#[test]
fn corrupt_saved_source_fails_closed() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    session_files::detail(&open, &stored, &entry.file_id).unwrap();
    file_io::atomic(&open.path(&stored.manifest.snapshot.session_id, &format!("source-{}.json", entry.file_id)).unwrap(), b"{broken").unwrap();
    assert_eq!(session_files::detail(&open, &stored, &entry.file_id).unwrap_err().code, "recovery_required");
}

#[test]
fn first_open_rejects_external_bytes_and_deletions_without_adopting_them() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let entry = first(&open, &stored);
    let path = fixture.worktree.join(&entry.display_path);
    let index = session_store::index_state(&open.repo).unwrap();
    for bytes in [b"external edit".as_slice(), b"<<<<<<< HEAD\nnew wt\n=======\nnew base\n>>>>>>> main\n"] {
        fs::write(&path, bytes).unwrap();
        assert_eq!(session_files::detail(&open, &stored, &entry.file_id).unwrap_err().code, "stale");
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    fs::remove_file(&path).unwrap();
    assert_eq!(session_files::detail(&open, &stored, &entry.file_id).unwrap_err().code, "stale");
    assert_eq!(session_store::index_state(&open.repo).unwrap(), index);
    assert!(!open.path(&stored.manifest.snapshot.session_id, &format!("source-{}.json", entry.file_id)).unwrap().exists());
}

#[test]
fn missing_merge_baseline_is_read_only_instead_of_trusting_current_file() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let mut stored = open.active().unwrap().unwrap();
    let entry = first(&open, &stored);
    stored.initial_work_tree = None; open.save(&stored).unwrap();
    let detail = session_files::detail(&open, &stored, &entry.file_id).unwrap();
    assert_eq!(detail.capability, "external_only");
    assert_eq!(detail.reason.as_deref(), Some("missing_merge_baseline"));
    assert!(detail.source.is_none());
    assert!(!open.path(&stored.manifest.snapshot.session_id, &format!("source-{}.json", entry.file_id)).unwrap().exists());
}
