use super::{file_io, parser};
use std::{fs, path::PathBuf, process::Command};

struct Fixture(PathBuf);
impl Fixture {
    /// 所有 Git 场景均使用测试拥有的临时仓库。
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("cli-manager-conflicts-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    /// 仅清理 UUID 测试目录，不改变开发者仓库。
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

/// 检查 Git 退出状态，避免失败夹具被记成通过。
fn git(root: &std::path::Path, args: &[&str]) -> std::process::Output {
    let output = Command::new("git").current_dir(root).args(args).env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" }).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    output
}

/// 路径校验既拒绝穿越/ADS/设备名，也允许合法中文、空格、前导连字符和括号。
#[test]
fn rejects_unsafe_paths_without_overblocking_names() {
    let fixture = Fixture::new();
    for bad in ["../outside", "/absolute", "C:/drive", "a\\b", "a//b", "a/./b", "a/.GIT/config", "a:stream", "NUL.txt", "COM1", "trailing.", "trailing ", "x\0y"] {
        assert!(file_io::safe_path(&fixture.0, bad).is_err(), "{bad:?}");
    }
    for good in ["-leading [1].txt", "目录/空 格.txt", "file.lock", ".gitignore", "COM10.txt"] {
        assert!(file_io::safe_path(&fixture.0, good).is_ok(), "{good}");
    }
}

/// Windows junction 即使目标文件不存在，也不可被当作合法删除路径。
#[cfg(windows)]
#[test]
fn rejects_junction_parent_of_missing_file() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    let link = fixture.0.join("junction");
    let output = Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&outside.0).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let result = file_io::safe_path(&fixture.0, "junction/missing.txt");
    fs::remove_dir(&link).unwrap();
    assert!(result.is_err());
}

/// Unix 符号链接父目录与 Windows junction 使用同一拒绝边界。
#[cfg(unix)]
#[test]
fn rejects_symlink_parent_of_missing_file() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    std::os::unix::fs::symlink(&outside.0, fixture.0.join("link")).unwrap();
    assert!(file_io::safe_path(&fixture.0, "link/missing.txt").is_err());
}

/// 替换旧文件、独立 JSON 限制和流式指纹都直接验证生产函数。
#[test]
fn atomic_replace_and_bounded_reads_preserve_bytes() {
    let fixture = Fixture::new();
    let path = fixture.0.join("data");
    file_io::atomic(&path, b"original").unwrap();
    file_io::atomic(&path, b"\xef\xbb\xbfnext\r\nlast").unwrap();
    let bytes = fs::read(&path).unwrap();
    assert_eq!(bytes, b"\xef\xbb\xbfnext\r\nlast");
    assert_eq!(file_io::fingerprint(&path).unwrap(), file_io::hash(&bytes));
    assert!(file_io::bounded(&path, 3).is_err());
    let oversized_json = "\u{1}".repeat(parser::MAX_JSON_BYTES / 6 + 1);
    assert!(file_io::write_json(&path, &oversized_json).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

/// 从真实 linked Worktree 的 diff3 输出验证源方向和普通暂存/提交保护。
#[test]
fn real_git_merge_direction_and_ordinary_write_guard() {
    let fixture = Fixture::new();
    let main = fixture.0.join("main");
    fs::create_dir(&main).unwrap();
    git(&main, &["init", "-b", "main"]);
    git(&main, &["config", "user.name", "Fixture"]);
    git(&main, &["config", "user.email", "fixture@example.invalid"]);
    git(&main, &["config", "core.autocrlf", "false"]);
    git(&main, &["config", "core.hooksPath", "disabled-hooks"]);
    fs::write(main.join("file.txt"), b"ancestor\n").unwrap();
    git(&main, &["add", "file.txt"]);
    git(&main, &["commit", "-m", "initial"]);
    let worktree = fixture.0.join("task");
    git(&main, &["worktree", "add", "-b", "task", worktree.to_str().unwrap()]);
    fs::write(main.join("file.txt"), b"target\n").unwrap();
    git(&main, &["commit", "-am", "target"]);
    fs::write(worktree.join("file.txt"), b"worktree\n").unwrap();
    git(&worktree, &["commit", "-am", "worktree"]);
    let output = Command::new("git").current_dir(&worktree).args(["-c", "merge.conflictStyle=diff3", "merge", "--no-commit", "--no-ff", "main"]).output().unwrap();
    assert!(!output.status.success());
    let repo = git2::Repository::open(&worktree).unwrap();
    assert_ne!(repo.path(), git2::Repository::open(&main).unwrap().path());
    assert!(crate::repo_operation::begin_ordinary_write(&repo).is_err());
    let bytes = fs::read(worktree.join("file.txt")).unwrap();
    let blocks = parser::parse(&bytes, 7).unwrap();
    assert_eq!(&bytes[blocks[0].worktree.clone()], b"worktree\n");
    assert_eq!(&bytes[blocks[0].base.clone()], b"target\n");
    let rebuilt = parser::rebuild(&bytes, &blocks, &[parser::Choice::Base]).unwrap();
    fs::write(worktree.join("file.txt"), rebuilt).unwrap();
    git(&worktree, &["add", "--", "file.txt"]);
    assert!(!repo.index().unwrap().has_conflicts());
    assert!(crate::repo_operation::begin_ordinary_write(&repo).is_err());
    git(&worktree, &["merge", "--abort"]);
    assert!(crate::repo_operation::begin_ordinary_write(&git2::Repository::open(&worktree).unwrap()).is_ok());
}
