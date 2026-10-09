use super::{file_io, session_store::{self, Open}, types::*};
use git2::Repository;
use std::{fs, path::{Path, PathBuf}, process::Command};

pub struct Fixture { pub root: PathBuf, pub main: PathBuf, pub worktree: PathBuf }
impl Drop for Fixture {
    /// UUID 临时目录归本例所有；不接触开发者仓库。
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
}

/// 禁用全局配置，夹具明确设置身份、换行及 hooks。
pub fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().into()
}

impl Fixture {
    /// 一次性生成 N 个真实冲突，避免测试实现依赖产品存储格式。
    pub fn new(count: usize) -> Self {
        let root = std::env::temp_dir().join(format!("cli-conflict-{}", uuid::Uuid::new_v4()));
        let main = root.join("main"); let worktree = root.join("task");
        fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-b", "main"]);
        for (key, value) in [("user.name", "Fixture"), ("user.email", "test@example.invalid"),
            ("core.autocrlf", "false"), ("core.hooksPath", "disabled-hooks"), ("commit.gpgsign", "false")] {
            git(&main, &["config", key, value]);
        }
        for n in 0..count { fs::write(main.join(format!("file-{n:04}.txt")), b"ancestor\n").unwrap(); }
        git(&main, &["add", "."]); git(&main, &["commit", "-m", "initial"]);
        git(&main, &["worktree", "add", "-b", "wt/task", worktree.to_str().unwrap()]);
        for n in 0..count {
            fs::write(main.join(format!("file-{n:04}.txt")), b"base branch\n").unwrap();
            fs::write(worktree.join(format!("file-{n:04}.txt")), b"worktree\n").unwrap();
        }
        git(&main, &["commit", "-am", "base changed"]);
        git(&worktree, &["commit", "-am", "worktree changed"]);
        Self { root, main, worktree }
    }
    pub fn context(&self) -> Context { Context { project_path: self.main.to_string_lossy().into(),
        worktree_path: self.worktree.to_string_lossy().into(), worktree_branch: "wt/task".into(), base_branch: "main".into() } }
    pub fn tips(&self) -> (String, String) { (git(&self.worktree, &["rev-parse", "HEAD"]), git(&self.main, &["rev-parse", "main"])) }
    pub fn prepare(&self) -> Snapshot { let (head, base) = self.tips(); session_store::prepare(&self.context(), &head, &base, "prepare-test").unwrap() }
}

fn clean_merge_fixture() -> Fixture {
    let fixture = Fixture::new(1);
    fs::write(fixture.worktree.join("file-0000.txt"), b"base branch\n").unwrap();
    git(&fixture.worktree, &["commit", "-am", "same content without shared commit"]);
    fs::write(fixture.main.join("base-only.txt"), b"new base content\n").unwrap();
    git(&fixture.main, &["add", "base-only.txt"]);
    git(&fixture.main, &["commit", "-m", "add base file"]);
    fixture
}

#[test]
fn clean_merge_preparation_can_be_aborted_without_auto_merge_reference() {
    let fixture = clean_merge_fixture();
    let snapshot = fixture.prepare();
    assert_eq!(snapshot.state, State::Ready);
    assert_eq!(snapshot.total, 0);
    let open = Open::new(&fixture.context()).unwrap();
    let stored = open.active().unwrap().unwrap();
    assert!(stored.initial_work_tree.is_some());
    assert!(fixture.worktree.join("base-only.txt").exists());
    let result = super::session_abort::abort(&open, &stored, snapshot.revision, "abort-clean").unwrap();
    assert_eq!(result.state, State::Aborted);
    assert!(!fixture.worktree.join("base-only.txt").exists());
    assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD"]), snapshot.head_oid);
    assert!(git(&fixture.worktree, &["status", "--porcelain"]).is_empty());
}

#[test]
fn clean_merge_preparation_can_be_committed_with_fixed_parents() {
    let fixture = clean_merge_fixture();
    let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap();
    let stored = open.active().unwrap().unwrap();
    let result = super::session_commit::continue_merge(&open, &stored, snapshot.revision, "Merge clean target", "commit-clean").unwrap();
    assert_eq!(result.state, State::Completed);
    let commit = open.repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(commit.parent_id(0).unwrap().to_string(), snapshot.head_oid);
    assert_eq!(commit.parent_id(1).unwrap().to_string(), snapshot.base_oid);
    assert!(git(&fixture.worktree, &["status", "--porcelain"]).is_empty());
    assert_eq!(git(&fixture.main, &["rev-parse", "HEAD"]), snapshot.base_oid);
}

#[test]
fn prepare_persists_fixed_stage_sides_without_touching_main() {
    let fixture = Fixture::new(1); let context = fixture.context(); let (head, base) = fixture.tips();
    let main_index = file_io::fingerprint(&Repository::open(&fixture.main).unwrap().path().join("index")).unwrap();
    let snapshot = fixture.prepare();
    assert_eq!(snapshot.state, State::Resolving); assert_eq!(snapshot.total, 1);
    assert_eq!(snapshot.head_oid, head); assert_eq!(snapshot.base_oid, base);
    assert_eq!(git(&fixture.main, &["rev-parse", "HEAD"]), base);
    assert_eq!(fs::read(fixture.main.join("file-0000.txt")).unwrap(), b"base branch\n");
    assert_eq!(file_io::fingerprint(&Repository::open(&fixture.main).unwrap().path().join("index")).unwrap(), main_index);
    assert!(!Repository::open(&fixture.main).unwrap().path().join("MERGE_HEAD").exists());
    let open = Open::new(&context).unwrap(); let stored = open.active().unwrap().unwrap();
    assert_eq!(stored.manifest.snapshot.session_id, snapshot.session_id);
    let page = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 200).unwrap();
    let stages = &page.files[0].stages;
    for (stage, content) in [(2, b"worktree\n".as_slice()), (3, b"base branch\n".as_slice())] {
        let oid = git2::Oid::from_str(&stages.iter().find(|s| s.stage == stage).unwrap().oid).unwrap();
        assert_eq!(open.repo.find_blob(oid).unwrap().content(), content);
    }
    drop(open);
    assert_eq!(session_store::prepare(&context, &head, &base, "prepare-test").unwrap().session_id, snapshot.session_id);
    assert_eq!(session_store::prepare(&context, &base, &head, "prepare-test").unwrap_err().code, "stale");
    assert_eq!(session_store::prepare(&context, &head, &base, "another-operation").unwrap_err().code, "busy");
}

#[test]
fn original_collection_pages_survive_restart_and_external_stage_all() {
    let fixture = Fixture::new(201); let snapshot = fixture.prepare(); let context = fixture.context();
    let open = Open::new(&context).unwrap(); let stored = open.active().unwrap().unwrap();
    let first = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 200).unwrap();
    assert_eq!(first.files.len(), 200); assert_eq!(first.next_cursor, Some(200));
    assert_eq!(session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 201).unwrap_err().code, "limit_exceeded");
    assert_eq!(session_store::page(&open, &stored, "wrong-snapshot", 0, 200).unwrap_err().code, "stale");
    drop(open);
    git(&fixture.worktree, &["add", "."]);
    let open = Open::new(&context).unwrap(); let stored = open.active().unwrap().unwrap();
    let last = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 200, 200).unwrap();
    assert_eq!(last.files.len(), 1); assert_eq!(last.next_cursor, None); assert_eq!(last.snapshot.total, 201);
    assert!(!last.files[0].resolved);
    assert_ne!(session_store::index_hash(&session_store::index_state(&open.repo).unwrap()).unwrap(), stored.index_hash.unwrap());
}

#[test]
fn file_ids_are_whitelisted_and_foreign_merge_head_is_rejected() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare();
    let open = Open::new(&fixture.context()).unwrap(); let stored = open.active().unwrap().unwrap();
    let page = session_store::page(&open, &stored, &snapshot.list_snapshot_id, 0, 1).unwrap();
    assert_eq!(session_store::file(&open, &stored, &page.files[0].file_id).unwrap().display_path, "file-0000.txt");
    for id in ["../HEAD", "file-0000.txt", "f-0-0-forged", "f-999-0-forged"] {
        assert!(session_store::file(&open, &stored, id).is_err());
    }
    fs::write(open.repo.path().join("MERGE_HEAD"), format!("{}\n", snapshot.head_oid)).unwrap();
    assert_eq!(open.owned(&stored).unwrap_err().code, "foreign_operation");
}

#[test]
fn preparing_intent_is_not_replayed_after_interruption() {
    let fixture = Fixture::new(1); let snapshot = fixture.prepare(); let (head, base) = fixture.tips();
    let open = Open::new(&fixture.context()).unwrap(); let mut stored = open.active().unwrap().unwrap();
    stored.manifest.snapshot.state = State::Preparing; open.save(&stored).unwrap(); drop(open);
    let before = fs::read(fixture.worktree.join("file-0000.txt")).unwrap();
    assert_eq!(session_store::prepare(&fixture.context(), &head, &base, "prepare-test").unwrap_err().code, "recovery_required");
    assert_eq!(before, fs::read(fixture.worktree.join("file-0000.txt")).unwrap());
    assert_eq!(git(&fixture.worktree, &["rev-parse", "MERGE_HEAD"]), snapshot.base_oid);
}

#[test]
fn dirty_worktree_and_wrong_registration_are_rejected_before_intent() {
    let fixture = Fixture::new(1); let (head, base) = fixture.tips(); let context = fixture.context();
    fs::write(fixture.worktree.join("untracked.txt"), b"keep").unwrap();
    assert_eq!(session_store::prepare(&context, &head, &base, "dirty").unwrap_err().code, "dirty_worktree");
    assert!(!Repository::open(&fixture.worktree).unwrap().path().join("cli-manager-conflict-active.json").exists());
    let mut wrong = context.clone(); wrong.worktree_branch = "wt/wrong".into();
    assert!(Open::new(&wrong).is_err());
    let other = Fixture::new(1); wrong = context; wrong.project_path = other.main.to_string_lossy().into();
    assert!(Open::new(&wrong).is_err());
}
