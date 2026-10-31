use std::fs;
use super::{file_io, session_index, session_store::{self, Open, Stored}, session_tests::{Fixture, git}, types::*};

fn first(open: &Open, stored: &Stored) -> FileEntry {
    session_store::page(open, stored, &stored.manifest.snapshot.list_snapshot_id, 0, 200).unwrap().files.remove(0)
}

/// 仅测试夹具手工构造凭据；生产代码尚未开放 finalize IPC。
fn receipt(open: &Open, stored: &Stored, entry: &FileEntry) {
    let stage = session_store::index_state(&open.repo).unwrap().get(&entry.display_path).map(|s| s[0].clone());
    let receipt = Receipt { file_id: entry.file_id.clone(), stage,
        work_hash: file_io::fingerprint(&open.identity.worktree_root.join(&entry.display_path)).unwrap(),
        operation_id: "fixture-receipt".into(), payload_hash: file_io::hash(b"fixture-only") };
    file_io::write_json(&open.path(&stored.manifest.snapshot.session_id, &format!("receipt-{}.json", entry.file_id)).unwrap(), &receipt).unwrap();
}

#[test]
fn unchanged_baseline_is_valid_but_not_ready_to_commit() {
    let fixture = Fixture::new(2); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let valid = session_index::validate(&open, &stored, false).unwrap();
    assert_eq!(valid.unresolved, 2); assert!(valid.receipts.is_empty()); assert_eq!(valid.index.len(), 2);
    assert_eq!(session_index::validate(&open, &stored, true).err().unwrap().code, "unresolved");
}

#[test]
fn externally_staging_markers_does_not_resolve_original_conflicts() {
    let fixture = Fixture::new(1); fixture.prepare();
    git(&fixture.worktree, &["add", "."]);
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    assert_eq!(session_index::validate(&open, &stored, false).err().unwrap().code, "stale");
    assert_eq!(session_index::validate(&open, &stored, true).err().unwrap().code, "stale");
}

#[test]
fn receipts_validate_exact_stage_and_work_content_not_just_conflict_count() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    fs::write(fixture.worktree.join(&entry.display_path), b"resolved").unwrap();
    git(&fixture.worktree, &["add", "--", &entry.display_path]); receipt(&open, &stored, &entry);
    assert_eq!(session_index::validate(&open, &stored, true).unwrap().unresolved, 0);
    fs::write(fixture.worktree.join(&entry.display_path), b"external changes").unwrap();
    assert_eq!(session_index::validate(&open, &stored, true).err().unwrap().code, "stale");
}

#[test]
fn unrelated_index_entries_are_rejected_after_all_conflicts_resolved() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    fs::write(fixture.worktree.join(&entry.display_path), b"resolved").unwrap();
    git(&fixture.worktree, &["add", "--", &entry.display_path]); receipt(&open, &stored, &entry);
    fs::write(fixture.worktree.join("unrelated.txt"), b"do not commit").unwrap(); git(&fixture.worktree, &["add", "unrelated.txt"]);
    assert_eq!(session_index::validate(&open, &stored, true).err().unwrap().code, "stale");
}

#[test]
fn deletion_receipt_requires_missing_work_file() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap(); let entry = first(&open, &stored);
    git(&fixture.worktree, &["rm", "-f", "--", &entry.display_path]); receipt(&open, &stored, &entry);
    assert!(session_index::validate(&open, &stored, true).unwrap().index.is_empty());
    fs::write(fixture.worktree.join(&entry.display_path), b"recreated").unwrap();
    assert_eq!(session_index::validate(&open, &stored, true).err().unwrap().code, "stale");
}

#[test]
fn corrupted_baseline_cannot_approve_an_external_index() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    file_io::atomic(&open.path(&stored.manifest.snapshot.session_id, "index-0.json").unwrap(), b"[]").unwrap();
    assert_eq!(session_index::validate(&open, &stored, false).err().unwrap().code, "recovery_required");
}
