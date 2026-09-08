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

// 构造指定空白模式与上下文的测试选项，不提前校验，以便覆盖非法参数。
fn options(whitespace: GitDiffWhitespaceMode, context_lines: u32) -> GitDiffOptions {
    GitDiffOptions {
        whitespace,
        context_lines,
    }
}

#[cfg(unix)]
// 在测试临时仓库运行给定 Git 参数，并要求退出成功。
fn git(temp: &TempDir, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(temp.path())
        .status()
        .unwrap();
    assert!(status.success(), "git command failed: {args:?}");
}

#[cfg(unix)]
// 创建独立临时仓库，设置仅仓库内生效的身份和换行配置，再提交初始 tracked.txt。
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
// 对临时仓库固定文件调用选项化 Diff 并返回文本，供真实 Git 行为断言使用。
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
// 统计首个 hunk 内以空格开头的上下文行，遇到下一 hunk 停止。
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
// 验证忽略行尾/全部空白分别生成正确开关，并携带指定的 10/20 行上下文参数。
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
// 验证不在允许集合内的五行上下文返回稳定选项错误。
fn invalid_context_lines_are_rejected() {
    assert_eq!(
        options(GitDiffWhitespaceMode::Exact, 5)
            .validate()
            .unwrap_err(),
        "remote_git_diff_options_invalid"
    );
}

#[test]
// 验证字节和行数上限本身可接受、超出一单位即拒绝，并检查响应统计值。
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
// 用临时仓库验证行尾与内部空白模式差异，并断言忽略空白结果不能分块回退。
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
// 在文件中部修改一行，验证三种上下文设置分别输出两侧合计 6/20/40 行。
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
// 验证未跟踪目标为目录时拒绝读取，保持非普通文件统一错误码。
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
// 验证指向仓库外普通文件的末端符号链接被拒绝，不跟随读取。
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
