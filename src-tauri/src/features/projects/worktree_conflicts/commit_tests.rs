use std::fs;
use super::{file_io, session_commit, session_files, session_store::{self, Open, Stored},
    session_tests::{Fixture, git}, session_write::{self, Action}, types::*};

fn ready(fixture: &Fixture) -> (Open, Stored) {
    fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap();
    let stored = open.active().unwrap().unwrap();
    let file = session_store::page(&open, &stored, &stored.manifest.snapshot.list_snapshot_id, 0, 200).unwrap().files.remove(0);
    let detail = session_files::detail(&open, &stored, &file.file_id).unwrap();
    session_write::resolve(&open, &stored, &file.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Side(Side::BaseBranch), "resolve-first").unwrap();
    let stored = open.active().unwrap().unwrap();
    (open, stored)
}

fn hook(fixture: &Fixture, body: &str) {
    let directory = fixture.root.join("hooks"); fs::create_dir_all(&directory).unwrap();
    let path = directory.join("pre-commit"); fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap(); }
    git(&fixture.main, &["config", "core.hooksPath", directory.to_str().unwrap()]);
}

#[test]
fn continue_creates_exact_fixed_parents_and_idempotent_audit() {
    let fixture = Fixture::new(1); let (open, stored) = ready(&fixture);
    // 目标分支前移不改写本轮固定的 base。
    git(&fixture.main, &["commit", "--allow-empty", "-m", "base advanced"]);
    let main_tip = git(&fixture.main, &["rev-parse", "HEAD"]);
    let result = session_commit::continue_merge(&open, &stored, stored.manifest.snapshot.revision, "resolve conflicts", "continue-one").unwrap();
    assert_eq!(result.state, State::Completed);
    let commit = open.repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(commit.parent_count(), 2);
    assert_eq!(commit.parent_id(0).unwrap().to_string(), stored.manifest.snapshot.head_oid);
    assert_eq!(commit.parent_id(1).unwrap().to_string(), stored.manifest.snapshot.base_oid);
    let again = session_commit::continue_merge(&open, &stored, stored.manifest.snapshot.revision, "resolve conflicts", "continue-one").unwrap();
    assert_eq!(again.revision, result.revision);
    assert_eq!(open.repo.head().unwrap().target(), Some(commit.id()));
    assert_eq!(git(&fixture.main, &["rev-parse", "HEAD"]), main_tip);
    assert_eq!(git(&fixture.worktree, &["status", "--porcelain"]), "");
    assert_eq!(session_commit::continue_merge(&open, &stored, stored.manifest.snapshot.revision, "different", "continue-one").unwrap_err().code, "stale");
}

#[test]
fn failed_hook_returns_ready_but_same_operation_is_never_replayed() {
    let fixture = Fixture::new(1); let (open, stored) = ready(&fixture);
    let counter = fixture.root.join("hook-count").to_string_lossy().replace(char::from(92), "/");
    hook(&fixture, &format!("echo call >> '{counter}'\nexit 1"));
    let revision = stored.manifest.snapshot.revision;
    assert_eq!(session_commit::continue_merge(&open, &stored, revision, "resolve", "hook-fail").unwrap_err().code, "commit_not_created");
    assert_eq!(open.active().unwrap().unwrap().manifest.snapshot.state, State::Ready);
    assert_eq!(session_commit::continue_merge(&open, &stored, revision, "resolve", "hook-fail").unwrap_err().code, "commit_not_created");
    assert_eq!(fs::read_to_string(fixture.root.join("hook-count")).unwrap().lines().count(), 1);
    assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD"]), stored.manifest.snapshot.head_oid);
    hook(&fixture, "exit 0");
    let current = open.active().unwrap().unwrap();
    assert_eq!(session_commit::continue_merge(&open, &current, current.manifest.snapshot.revision, "resolve", "hook-retry").unwrap().state, State::Completed);
}

#[test]
fn hook_index_mutation_preserves_commit_and_blocks_unknown_result() {
    let fixture = Fixture::new(1); let (open, stored) = ready(&fixture);
    hook(&fixture, "echo hook-change > injected.txt\ngit add -- injected.txt");
    assert_eq!(session_commit::continue_merge(&open, &stored, stored.manifest.snapshot.revision, "resolve", "hook-change").unwrap_err().code, "recovery_required");
    let head = git(&fixture.worktree, &["rev-parse", "HEAD"]);
    assert_ne!(head, stored.manifest.snapshot.head_oid);
    assert!(fixture.worktree.join("injected.txt").exists());
    assert!(open.path(&stored.manifest.snapshot.session_id, "pending-commit.json").unwrap().exists());
    assert_eq!(session_commit::reconcile(&open, &stored).unwrap_err().code, "recovery_required");
    assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD"]), head);
}

#[test]
fn lost_response_recovers_exact_commit_without_running_hook_again() {
    let fixture = Fixture::new(1); let (open, stored) = ready(&fixture);
    let revision = stored.manifest.snapshot.revision;
    session_commit::continue_merge(&open, &stored, revision, "resolve", "lost-response").unwrap();
    let head = git(&fixture.worktree, &["rev-parse", "HEAD"]);
    let audit_path = open.path(&stored.manifest.snapshot.session_id, "commit-lost-response.json").unwrap();
    let audit: serde_json::Value = file_io::read_json(&audit_path).unwrap();
    file_io::write_json(&open.path(&stored.manifest.snapshot.session_id, "pending-commit.json").unwrap(), &audit["intent"]).unwrap();
    fs::remove_file(audit_path).unwrap();
    let mut interrupted = stored.clone(); interrupted.manifest.snapshot.state = State::Committing;
    interrupted.manifest.pending_tree = audit["intent"]["treeOid"].as_str().map(String::from); open.save(&interrupted).unwrap();
    drop(open); hook(&fixture, "exit 1");
    let open = Open::new(&fixture.context()).unwrap();
    assert_eq!(session_commit::continue_merge(&open, &stored, revision, "resolve", "lost-response").unwrap().state, State::Completed);
    assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD"]), head);
}

#[test]
fn unresolved_or_unrelated_staging_is_rejected_before_commit_intent() {
    let fixture = Fixture::new(2); let (open, stored) = ready(&fixture);
    assert_eq!(session_commit::continue_merge(&open, &stored, stored.manifest.snapshot.revision, "resolve", "unresolved").unwrap_err().code, "unresolved");
    assert!(!open.path(&stored.manifest.snapshot.session_id, "pending-commit.json").unwrap().exists());
    drop(open); drop(fixture);
    let fixture = Fixture::new(1); let (open, stored) = ready(&fixture);
    fs::write(fixture.worktree.join("unrelated.txt"), "keep").unwrap(); git(&fixture.worktree, &["add", "unrelated.txt"]);
    assert_eq!(session_commit::continue_merge(&open, &stored, stored.manifest.snapshot.revision, "resolve", "unrelated").unwrap_err().code, "stale");
    assert!(!open.path(&stored.manifest.snapshot.session_id, "pending-commit.json").unwrap().exists());
}

#[test]
fn unstaged_changes_and_git_locks_are_preserved() {
    let fixture = Fixture::new(1); let (open, stored) = ready(&fixture);
    fs::write(fixture.worktree.join("untracked.txt"), "keep").unwrap();
    assert_eq!(session_commit::continue_merge(&open, &stored, stored.manifest.snapshot.revision, "resolve", "untracked").unwrap_err().code, "stale");
    fs::write(open.repo.path().join("index.lock"), "external lock").unwrap();
    assert_eq!(session_commit::continue_merge(&open, &stored, stored.manifest.snapshot.revision, "resolve", "locked").unwrap_err().code, "foreign_operation");
    assert_eq!(fs::read(open.repo.path().join("index.lock")).unwrap(), b"external lock");
    assert_eq!(fs::read(fixture.worktree.join("untracked.txt")).unwrap(), b"keep");
}

#[test]
fn pending_write_or_commit_prevents_draft_mutation() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let file = session_store::page(&open, &stored, &stored.manifest.snapshot.list_snapshot_id, 0, 1).unwrap().files.remove(0);
    let detail = session_files::detail(&open, &stored, &file.file_id).unwrap();
    for name in ["pending-write.json", "pending-commit.json"] {
        let path = open.path(&stored.manifest.snapshot.session_id, name).unwrap(); fs::write(&path, "{}").unwrap();
        assert_eq!(session_files::save_draft(&open, &stored, &file.file_id, &detail.version, 0, Default::default(), "pending").unwrap_err().code, "recovery_required");
        assert!(!open.path(&stored.manifest.snapshot.session_id, &format!("draft-{}.json", file.file_id)).unwrap().exists());
        fs::remove_file(path).unwrap();
    }
}

#[test]
fn successful_and_rejected_writes_leave_no_candidate_directories() {
    let fixture = Fixture::new(1); fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let file = session_store::page(&open, &stored, &stored.manifest.snapshot.list_snapshot_id, 0, 1).unwrap().files.remove(0);
    let detail = session_files::detail(&open, &stored, &file.file_id).unwrap();
    assert!(session_write::resolve(&open, &stored, &file.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Draft { revision: 0 }, "partial").is_err());
    session_write::resolve(&open, &stored, &file.file_id, &detail.version, stored.manifest.snapshot.revision, Action::Side(Side::Worktree), "whole").unwrap();
    let manifest = open.path(&stored.manifest.snapshot.session_id, "manifest.json").unwrap();
    assert!(!fs::read_dir(manifest.parent().unwrap()).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with("candidate-")));
}
