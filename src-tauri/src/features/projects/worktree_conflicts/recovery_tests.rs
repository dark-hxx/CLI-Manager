use super::{main_recovery::{self, Journal}, file_io};
use git2::Repository;
use std::{fs, path::{Path, PathBuf}, process::Command};

struct Fixture { root: PathBuf, main: PathBuf, worktree: PathBuf }
impl Drop for Fixture {
    /// 测试目录全部来自本例 UUID；不触碰开发仓库。
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); }
}

/// 测试命令禁用用户和系统 Git 配置，显式配置本地身份及 hooks。
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().into()
}

impl Fixture {
    /// 真实 linked Worktree 与主检出共享对象库，但使用独立 index。
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("cli-recovery-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        let worktree = root.join("task");
        fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-b", "main"]);
        for (key, value) in [("user.name", "Fixture"), ("user.email", "test@example.invalid"),
            ("core.autocrlf", "false"), ("core.hooksPath", "disabled-hooks"),
            ("commit.gpgsign", "false")] { git(&main, &["config", key, value]); }
        fs::write(main.join("file.txt"), b"ancestor\n").unwrap();
        git(&main, &["add", "file.txt"]);
        git(&main, &["commit", "-m", "initial"]);
        git(&main, &["worktree", "add", "-b", "wt/task", worktree.to_str().unwrap()]);
        Self { root, main, worktree }
    }

    /// 让两侧对同一行产生确定性的真实 Git 冲突。
    fn conflict(&self) {
        fs::write(self.main.join("file.txt"), b"main\n").unwrap();
        git(&self.main, &["commit", "-am", "main"]);
        fs::write(self.worktree.join("file.txt"), b"worktree\n").unwrap();
        git(&self.worktree, &["commit", "-am", "worktree"]);
    }
}

/// 日志跨 Repository 实例保留；原有脏内容不应误判为无法恢复。
#[test]
fn restart_recheck_accepts_exact_dirty_baseline() {
    let fixture = Fixture::new();
    fs::write(fixture.main.join("file.txt"), b"staged\n").unwrap();
    git(&fixture.main, &["add", "file.txt"]);
    fs::write(fixture.main.join("file.txt"), b"unstaged\n").unwrap();
    fs::write(fixture.main.join("untracked.txt"), b"keep\n").unwrap();
    let repo = Repository::open(&fixture.main).unwrap();
    let mut journal = Journal::begin(&repo).unwrap();
    journal.phase("stashing", None).unwrap();
    assert!(crate::repo_operation::begin_ordinary_write(&repo).is_err());
    drop(journal);
    drop(repo);
    let reopened = Repository::open(&fixture.main).unwrap();
    let status = main_recovery::probe(&reopened).unwrap();
    assert!(status.blocked && status.can_confirm);
    let next = main_recovery::recheck(&reopened, status.state_token.as_deref(), false).unwrap();
    assert!(!next.blocked);
    assert_eq!(fs::read(fixture.main.join("file.txt")).unwrap(), b"unstaged\n");
    assert_eq!(git(&fixture.main, &["show", ":file.txt"]), "staged");
    assert!(crate::repo_operation::begin_ordinary_write(&reopened).is_ok());
}

/// 用户确认绑定当前完整状态；有任何内容变化都必须重新展示确认。
#[test]
fn manual_confirmation_rejects_stale_state_and_preserves_files() {
    let fixture = Fixture::new();
    let repo = Repository::open(&fixture.main).unwrap();
    Journal::begin(&repo).unwrap();
    let initial = main_recovery::probe(&repo).unwrap();
    fs::write(fixture.main.join("file.txt"), b"manual\n").unwrap();
    let error = main_recovery::recheck(&repo, initial.state_token.as_deref(), true).unwrap_err();
    assert_eq!(error.code, "stale");
    let current = main_recovery::probe(&repo).unwrap();
    assert!(main_recovery::recheck(&repo, current.state_token.as_deref(), false).unwrap().blocked);
    assert!(!main_recovery::recheck(&repo, current.state_token.as_deref(), true).unwrap().blocked);
    assert_eq!(fs::read(fixture.main.join("file.txt")).unwrap(), b"manual\n");
    let audits: Vec<_> = fs::read_dir(repo.path()).unwrap().filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("cli-manager-recovery-audit-")).collect();
    assert_eq!(audits.len(), 1);
    let audit: serde_json::Value = file_io::read_json(&audits[0].path()).unwrap();
    assert_eq!(audit["manualConfirmation"], true);
}

/// 损坏日志保持阻断，只能显式确认；外来 MERGE_HEAD 即使没有冲突也不解除。
#[test]
fn corrupt_journal_and_foreign_operation_fail_closed() {
    let fixture = Fixture::new();
    let repo = Repository::open(&fixture.main).unwrap();
    fs::write(repo.path().join("cli-manager-main-recovery.json"), b"broken").unwrap();
    let status = main_recovery::probe(&repo).unwrap();
    assert_eq!(status.reason.as_deref(), Some("recovery_journal_corrupt"));
    assert!(main_recovery::recheck(&repo, status.state_token.as_deref(), false).unwrap().blocked);
    fs::write(repo.path().join("MERGE_HEAD"), git(&fixture.main, &["rev-parse", "HEAD"])).unwrap();
    let blocked = main_recovery::recheck(&repo, status.state_token.as_deref(), true).unwrap();
    assert!(blocked.blocked && !blocked.can_confirm);
    fs::remove_file(repo.path().join("MERGE_HEAD")).unwrap();
    assert!(!main_recovery::recheck(&repo, status.state_token.as_deref(), true).unwrap().blocked);
}

/// 普通合并失败返回冲突前，必须完成 abort 并回到进入操作时的分支。
#[test]
fn normal_conflict_returns_to_original_branch_without_merge_state() {
    let fixture = Fixture::new();
    fixture.conflict();
    git(&fixture.main, &["checkout", "-b", "side"]);
    let result = super::super::merge_worktree_internal(fixture.main.to_str().unwrap(), "wt/task", "main", false).unwrap();
    assert!(!result.merged);
    assert!(!result.conflict_files.is_empty());
    assert_eq!(git(&fixture.main, &["branch", "--show-current"]), "side");
    let repo = Repository::open(&fixture.main).unwrap();
    assert!(!main_recovery::probe(&repo).unwrap().blocked);
    assert!(!repo.path().join("MERGE_HEAD").exists());
    assert!(git(&fixture.main, &["status", "--porcelain"]).is_empty());
}

/// 强制合并冲突后在原分支恢复 staged/unstaged/untracked，并保留精确 stash。
#[test]
fn forced_conflict_restores_original_dirty_branch_and_keeps_stash() {
    let fixture = Fixture::new();
    fixture.conflict();
    git(&fixture.main, &["checkout", "-b", "side"]);
    fs::write(fixture.main.join("keep.txt"), b"staged\n").unwrap();
    git(&fixture.main, &["add", "keep.txt"]);
    fs::write(fixture.main.join("keep.txt"), b"unstaged\n").unwrap();
    fs::write(fixture.main.join("untracked.txt"), b"keep\n").unwrap();
    let result = super::super::merge_worktree_internal(fixture.main.to_str().unwrap(), "wt/task", "main", true).unwrap();
    assert!(!result.merged && result.stash_restored);
    assert_eq!(git(&fixture.main, &["branch", "--show-current"]), "side");
    assert_eq!(git(&fixture.main, &["show", ":keep.txt"]), "staged");
    assert_eq!(fs::read(fixture.main.join("keep.txt")).unwrap(), b"unstaged\n");
    assert_eq!(fs::read(fixture.main.join("untracked.txt")).unwrap(), b"keep\n");
    assert!(!git(&fixture.main, &["rev-parse", "refs/stash"]).is_empty());
    assert!(!main_recovery::probe(&Repository::open(&fixture.main).unwrap()).unwrap().blocked);
}

/// 工作目录被外部移走后，仍从 Git 登记保护未完成会话与外部锁。
#[test]
fn missing_directory_cannot_bypass_registered_recovery_or_git_locks() {
    let fixture = Fixture::new();
    let repo = Repository::open(&fixture.main).unwrap();
    let private = Repository::open(&fixture.worktree).unwrap().path().to_path_buf();
    fs::rename(&fixture.worktree, fixture.root.join("moved")).unwrap();
    for marker in ["cli-manager-conflict-active.json", "MERGE_HEAD", "index.lock", "HEAD.lock"] {
        fs::write(private.join(marker), b"preserve").unwrap();
        assert!(super::cleanup_guard::lock_registered(&repo, &fixture.worktree).is_err(), "{marker}");
        assert_eq!(fs::read(private.join(marker)).unwrap(), b"preserve");
        fs::remove_file(private.join(marker)).unwrap();
    }
    assert!(super::cleanup_guard::lock_registered(&repo, &fixture.worktree).unwrap().is_some());
}

/// 同一 Repository 长期存活时必须读取 CLI 写入后的真实 index。
#[test]
fn recovery_confirmation_detects_external_index_changes() {
    let fixture = Fixture::new();
    let repo = Repository::open(&fixture.main).unwrap();
    Journal::begin(&repo).unwrap();
    let before = main_recovery::probe(&repo).unwrap();
    let blob = git(&fixture.main, &["hash-object", "-w", "--stdin"]);
    git(&fixture.main, &["update-index", "--add", "--cacheinfo", &format!("100644,{blob},index-only.txt")]);
    assert_eq!(main_recovery::recheck(&repo, before.state_token.as_deref(), true).unwrap_err().code, "stale");
    assert!(repo.path().join("cli-manager-main-recovery.json").exists());
}

/// 清理单个失效登记不得 prune 另一个已丢失目录中的恢复日志。
#[test]
fn targeted_cleanup_preserves_other_missing_worktree_recovery() {
    let fixture = Fixture::new();
    let other = fixture.root.join("other");
    git(&fixture.main, &["worktree", "add", "-b", "wt/other", other.to_str().unwrap()]);
    let other_private = Repository::open(&other).unwrap().path().to_path_buf();
    fs::write(other_private.join("cli-manager-conflict-active.json"), b"keep").unwrap();
    fs::rename(&other, fixture.root.join("other-moved")).unwrap();
    fs::rename(&fixture.worktree, fixture.root.join("task-moved")).unwrap();
    super::super::cleanup_registered_stale_worktree_path(&fixture.main, &fixture.worktree).unwrap();
    assert_eq!(fs::read(other_private.join("cli-manager-conflict-active.json")).unwrap(), b"keep");
    assert!(git(&fixture.main, &["worktree", "list", "--porcelain"]).contains("wt/other"));
}
