use super::{
    build_diff_payload, cli_diff_args, get_file_diff, GitDiffOptions, GitDiffWhitespaceMode,
    MAX_DIFF_BYTES, MAX_DIFF_LINES,
};
use git2::{IndexAddOption, Repository, Signature};
use std::fs;
use tempfile::TempDir;

fn options(whitespace: GitDiffWhitespaceMode, context_lines: u32) -> GitDiffOptions {
    GitDiffOptions {
        whitespace,
        context_lines,
    }
}

fn init_repo(content: &str) -> TempDir {
    let temp = tempfile::tempdir().unwrap();
    let repo = Repository::init(temp.path()).unwrap();
    fs::write(temp.path().join("tracked.txt"), content).unwrap();
    let mut index = repo.index().unwrap();
    index
        .add_all(["tracked.txt"], IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let signature = Signature::now("CLI Manager", "cli-manager@example.com").unwrap();
    repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
        .unwrap();
    drop(tree);
    drop(repo);
    temp
}

fn diff(temp: &TempDir, whitespace: GitDiffWhitespaceMode, context_lines: u32) -> String {
    get_file_diff(
        temp.path().to_string_lossy().as_ref(),
        "tracked.txt",
        "M",
        options(whitespace, context_lines),
    )
    .unwrap()
    .content
}

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
fn options_accept_only_supported_context_lines() {
    for context_lines in [3, 10, 20] {
        assert!(options(GitDiffWhitespaceMode::Exact, context_lines)
            .validate()
            .is_ok());
    }
    assert_eq!(
        options(GitDiffWhitespaceMode::Exact, 4)
            .validate()
            .unwrap_err(),
        "git_diff_options_invalid"
    );
}

#[test]
fn payload_limits_are_inclusive_and_report_metadata() {
    let byte_boundary = "a".repeat(MAX_DIFF_BYTES);
    let payload = build_diff_payload(byte_boundary, true).unwrap();
    assert_eq!(payload.byte_length, MAX_DIFF_BYTES);
    assert_eq!(payload.line_count, 1);
    assert!(payload.can_revert_hunks);
    assert_eq!(
        build_diff_payload("a".repeat(MAX_DIFF_BYTES + 1), false).unwrap_err(),
        "git_diff_too_large"
    );

    let line_boundary = "x\n".repeat(MAX_DIFF_LINES);
    let payload = build_diff_payload(line_boundary, false).unwrap();
    assert_eq!(payload.line_count, MAX_DIFF_LINES);
    assert_eq!(
        build_diff_payload("x\n".repeat(MAX_DIFF_LINES + 1), false).unwrap_err(),
        "git_diff_too_large"
    );
}

#[test]
fn cli_options_match_git_flags() {
    let ignore_eol = cli_diff_args(
        "src/lib.rs",
        "M",
        options(GitDiffWhitespaceMode::IgnoreEol, 10),
    );
    assert!(ignore_eol
        .iter()
        .any(|value| value == "--ignore-space-at-eol"));
    assert!(ignore_eol.iter().any(|value| value == "--unified=10"));
    assert!(ignore_eol.iter().any(|value| value == "HEAD"));

    let ignore_all = cli_diff_args(
        "src/lib.rs",
        "A",
        options(GitDiffWhitespaceMode::IgnoreAll, 20),
    );
    assert!(ignore_all.iter().any(|value| value == "--ignore-all-space"));
    assert!(ignore_all.iter().any(|value| value == "--unified=20"));
    assert!(!ignore_all.iter().any(|value| value == "HEAD"));
}

#[test]
fn native_diff_applies_each_whitespace_mode() {
    let trailing = init_repo("alpha\nvalue = 1\nomega\n");
    fs::write(
        trailing.path().join("tracked.txt"),
        "alpha  \nvalue = 1\nomega\n",
    )
    .unwrap();
    let exact = get_file_diff(
        trailing.path().to_string_lossy().as_ref(),
        "tracked.txt",
        "M",
        options(GitDiffWhitespaceMode::Exact, 3),
    )
    .unwrap();
    let ignore_eol = get_file_diff(
        trailing.path().to_string_lossy().as_ref(),
        "tracked.txt",
        "M",
        options(GitDiffWhitespaceMode::IgnoreEol, 3),
    )
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
fn native_diff_applies_each_context_size() {
    let original = (1..=50)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    let temp = init_repo(&original);
    let changed = original.replace("line 25\n", "changed 25\n");
    fs::write(temp.path().join("tracked.txt"), changed).unwrap();

    for (context_lines, expected) in [(3, 6), (10, 20), (20, 40)] {
        let content = diff(&temp, GitDiffWhitespaceMode::Exact, context_lines);
        assert_eq!(context_line_count(&content), expected);
    }
}
