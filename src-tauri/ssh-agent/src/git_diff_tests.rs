use super::{
    build_diff_payload, diff_args, validate_untracked_target, GitDiffOptions,
    GitDiffWhitespaceMode, MAX_DIFF_LINES,
};
#[cfg(unix)]
use super::{diff_with_options, DiffWithOptionsRequest};
use crate::git::MAX_DIFF_BYTES;
use std::fs;
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use tempfile::TempDir;

fn options(whitespace: GitDiffWhitespaceMode, context_lines: u32) -> GitDiffOptions {
    GitDiffOptions {
        whitespace,
        context_lines,
    }
}

#[cfg(unix)]
fn git(temp: &TempDir, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(temp.path())
        .status()
        .unwrap();
    assert!(status.success(), "git command failed: {args:?}");
}

#[cfg(unix)]
fn init_repo(content: &str) -> TempDir {
    let temp = tempfile::tempdir().unwrap();
    git(&temp, &["init", "--quiet"]);
    git(&temp, &["config", "core.autocrlf", "false"]);
    git(&temp, &["config", "user.name", "CLI Manager"]);
    git(&temp, &["config", "user.email", "cli-manager@example.com"]);
    fs::write(temp.path().join("tracked.txt"), content).unwrap();
    git(&temp, &["add", "--", "tracked.txt"]);
    git(&temp, &["commit", "--quiet", "-m", "initial"]);
    temp
}

#[cfg(unix)]
fn diff(temp: &TempDir, whitespace: GitDiffWhitespaceMode, context_lines: u32) -> String {
    diff_with_options(DiffWithOptionsRequest {
        root_path: temp.path().to_string_lossy().into_owned(),
        repo_path: String::new(),
        relative_path: "tracked.txt".to_string(),
        status: "M".to_string(),
        options: options(whitespace, context_lines),
    })
    .unwrap()
    .content
}

#[cfg(unix)]
fn context_line_count(content: &str) -> usize {
    content
        .lines()
        .skip_while(|line| !line.starts_with("@@"))
        .skip(1)
        .take_while(|line| !line.starts_with("@@"))
        .filter(|line| line.starts_with(' '))
        .count()
}

#[test]
fn diff_flags_match_the_desktop_contract() {
    let ignore_eol = diff_args(
        "src/lib.rs",
        "M",
        options(GitDiffWhitespaceMode::IgnoreEol, 10),
        false,
    );
    assert!(ignore_eol
        .iter()
        .any(|value| value == "--ignore-space-at-eol"));
    assert!(ignore_eol.iter().any(|value| value == "--unified=10"));

    let ignore_all = diff_args(
        "src/lib.rs",
        "M",
        options(GitDiffWhitespaceMode::IgnoreAll, 20),
        false,
    );
    assert!(ignore_all.iter().any(|value| value == "--ignore-all-space"));
    assert!(ignore_all.iter().any(|value| value == "--unified=20"));
}

#[test]
fn invalid_context_lines_are_rejected() {
    assert_eq!(
        options(GitDiffWhitespaceMode::Exact, 5)
            .validate()
            .unwrap_err(),
        "remote_git_diff_options_invalid"
    );
}

#[test]
fn payload_limits_match_desktop_and_report_metadata() {
    let payload = build_diff_payload("a".repeat(MAX_DIFF_BYTES), true).unwrap();
    assert_eq!(payload.byte_length, MAX_DIFF_BYTES);
    assert_eq!(payload.line_count, 1);
    assert_eq!(
        build_diff_payload("a".repeat(MAX_DIFF_BYTES + 1), false).unwrap_err(),
        "git_diff_too_large"
    );

    let payload = build_diff_payload("x\n".repeat(MAX_DIFF_LINES), false).unwrap();
    assert_eq!(payload.line_count, MAX_DIFF_LINES);
    assert_eq!(
        build_diff_payload("x\n".repeat(MAX_DIFF_LINES + 1), false).unwrap_err(),
        "git_diff_too_large"
    );
}

#[test]
#[cfg(unix)]
fn cli_diff_applies_each_whitespace_mode() {
    let trailing = init_repo("alpha\nvalue = 1\nomega\n");
    fs::write(
        trailing.path().join("tracked.txt"),
        "alpha  \nvalue = 1\nomega\n",
    )
    .unwrap();
    let exact = diff_with_options(DiffWithOptionsRequest {
        root_path: trailing.path().to_string_lossy().into_owned(),
        repo_path: String::new(),
        relative_path: "tracked.txt".to_string(),
        status: "M".to_string(),
        options: options(GitDiffWhitespaceMode::Exact, 3),
    })
    .unwrap();
    let ignore_eol = diff_with_options(DiffWithOptionsRequest {
        root_path: trailing.path().to_string_lossy().into_owned(),
        repo_path: String::new(),
        relative_path: "tracked.txt".to_string(),
        status: "M".to_string(),
        options: options(GitDiffWhitespaceMode::IgnoreEol, 3),
    })
    .unwrap();
    assert!(!exact.content.is_empty());
    assert!(exact.can_revert_hunks);
    assert!(ignore_eol.content.is_empty());
    assert!(!ignore_eol.can_revert_hunks);

    let internal = init_repo("alpha\nvalue = 1\nomega\n");
    fs::write(
        internal.path().join("tracked.txt"),
        "alpha\nvalue    =    1\nomega\n",
    )
    .unwrap();
    assert!(!diff(&internal, GitDiffWhitespaceMode::IgnoreEol, 3).is_empty());
    assert!(diff(&internal, GitDiffWhitespaceMode::IgnoreAll, 3).is_empty());
}

#[test]
#[cfg(unix)]
fn cli_diff_applies_each_context_size() {
    let original = (1..=50)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    let temp = init_repo(&original);
    fs::write(
        temp.path().join("tracked.txt"),
        original.replace("line 25\n", "changed 25\n"),
    )
    .unwrap();

    for (context_lines, expected) in [(3, 6), (10, 20), (20, 40)] {
        let content = diff(&temp, GitDiffWhitespaceMode::Exact, context_lines);
        assert_eq!(context_line_count(&content), expected);
    }
}

#[test]
fn untracked_diff_rejects_directories() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("nested");
    fs::create_dir(&directory).unwrap();
    assert_eq!(
        validate_untracked_target(&directory).unwrap_err(),
        "remote_git_symlink_rejected"
    );
}

#[cfg(unix)]
#[test]
fn untracked_diff_rejects_symlinks() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let link = root.path().join("link.txt");
    symlink(outside.path(), &link).unwrap();
    assert_eq!(
        validate_untracked_target(&link).unwrap_err(),
        "remote_git_symlink_rejected"
    );
}
