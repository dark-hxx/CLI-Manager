use super::snapshot::parse_wsl_numstat;
use super::{
    build_reverse_hunk_patch, build_reverse_lines_patch, build_worktree_snapshot,
    build_wsl_git_command_args, collect_git_changes_from_repo, format_open_repo_error,
    git_delete_untracked_paths, git_fork_worktree_snapshot, git_get_changes_native,
    git_get_file_diff, git_restore_worktree_snapshot, is_nested_repo_entry, is_no_stash_created,
    is_not_git_repository_error, is_not_git_repository_output, parse_wsl_git_status,
    remove_untracked_snapshot_file, scan_git_repository_paths, should_skip_diff_line_stats,
    validate_branch_name, validate_repo_relative_path, validate_snapshot_branch_name,
    GIT_DIFF_LINE_STATS_STATUS_LIMIT, MAX_WORKTREE_PATCH_BYTES, NOT_GIT_REPOSITORY_CODE,
};
use git2::{IndexAddOption, Repository, Signature};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

// 用 libgit2 初始化临时仓库，并提交 tracked.txt 作为测试基线。
fn init_temp_repo() -> (TempDir, String) {
    let temp = tempfile::tempdir().unwrap();
    let repo = Repository::init(temp.path()).unwrap();
    fs::write(temp.path().join("tracked.txt"), "base\n").unwrap();

    let mut index = repo.index().unwrap();
    index
        .add_all(["tracked.txt"], IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = Signature::now("CLI Manager", "cli-manager@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
        .unwrap();

    let path = temp.path().to_string_lossy().to_string();
    (temp, path)
}

// 从测试仓库快照提取 HEAD 和工作区补丁。
fn snapshot_patch(repo_path: &str) -> (String, String) {
    let repo = Repository::open(repo_path).unwrap();
    let snapshot = build_worktree_snapshot(repo_path, &repo).unwrap();
    (snapshot.head, snapshot.patch)
}

// 将测试仓库全部路径加入索引，并基于当前 HEAD 创建提交。
fn commit_all(repo: &Repository, message: &str) {
    let mut index = repo.index().unwrap();
    index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap();
    let sig = Signature::now("CLI Manager", "cli-manager@example.com").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
        .unwrap();
}

// 读取测试跟踪文件并将 CRLF 归一化为 LF。
fn tracked_file(repo_path: &str) -> String {
    fs::read_to_string(Path::new(repo_path).join("tracked.txt"))
        .unwrap()
        .replace("\r\n", "\n")
}

// 读取测试仓库 HEAD 的短引用名。
fn current_branch(repo_path: &str) -> String {
    let repo = Repository::open(repo_path).unwrap();
    let head = repo.head().unwrap();
    head.shorthand().unwrap().to_string()
}

#[tokio::test]
// 验证 GBK 文件差异可读且禁用局部回滚。
async fn file_diff_decodes_gbk_and_disables_partial_revert() {
    let (_temp, repo_path) = init_temp_repo();
    let repo = Repository::open(&repo_path).unwrap();
    let file = Path::new(&repo_path).join("legacy.cs");
    let old_text = "旧版本中文内容，用于验证传统编码差异。\n";
    let new_text = "新版本中文内容，用于验证传统编码差异。\n";
    let (old_bytes, _, old_errors) = encoding_rs::GBK.encode(old_text);
    assert!(!old_errors);
    fs::write(&file, old_bytes.as_ref()).unwrap();
    commit_all(&repo, "add legacy file");
    let (new_bytes, _, new_errors) = encoding_rs::GBK.encode(new_text);
    assert!(!new_errors);
    fs::write(&file, new_bytes.as_ref()).unwrap();
    drop(repo);

    let payload = git_get_file_diff(repo_path, "legacy.cs".to_string(), "M".to_string(), None)
        .await
        .unwrap();

    assert!(payload.content.contains(old_text.trim()));
    assert!(payload.content.contains(new_text.trim()));
    assert!(!payload.can_revert_hunks);
}

#[tokio::test]
// 验证 UTF-16 差异按文本解码并保留上下文，而非显示二进制差异。
async fn file_diff_decodes_utf16_text_instead_of_treating_it_as_binary() {
    let (_temp, repo_path) = init_temp_repo();
    let repo = Repository::open(&repo_path).unwrap();
    let file = Path::new(&repo_path).join("legacy-utf16.cs");
    let old_text = "共同第一行。\nUTF16 旧版本中文内容。\n共同第三行。\n";
    let new_text = "共同第一行。\nUTF16 新版本中文内容。\n共同第三行。\n";
    fs::write(
        &file,
        crate::text_encoding::encode_text(old_text, "utf-16le", true).unwrap(),
    )
    .unwrap();
    commit_all(&repo, "add utf16 file");
    fs::write(
        &file,
        crate::text_encoding::encode_text(new_text, "utf-16le", true).unwrap(),
    )
    .unwrap();
    drop(repo);

    let payload = git_get_file_diff(
        repo_path,
        "legacy-utf16.cs".to_string(),
        "M".to_string(),
        None,
    )
    .await
    .unwrap();

    assert!(payload.content.contains("共同第一行。"));
    assert!(payload.content.contains("UTF16 旧版本中文内容。"));
    assert!(payload.content.contains("UTF16 新版本中文内容。"));
    assert!(payload.content.contains("共同第三行。"));
    assert!(!payload.content.contains("Binary files"));
    assert!(!payload.can_revert_hunks);
}

#[tokio::test]
// 验证普通 UTF-8 文件差异仍允许局部回滚。
async fn utf8_file_diff_keeps_partial_revert_enabled() {
    let (_temp, repo_path) = init_temp_repo();
    fs::write(Path::new(&repo_path).join("tracked.txt"), "changed\n").unwrap();

    let payload = git_get_file_diff(repo_path, "tracked.txt".to_string(), "M".to_string(), None)
        .await
        .unwrap();

    assert!(payload.content.contains("-base"));
    assert!(payload.content.contains("+changed"));
    assert!(payload.can_revert_hunks);
}

#[test]
// 验证仓库扫描的根优先、限深和重目录排除规则。
fn scan_git_repository_paths_respects_depth_and_exclusions() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    // 根仓库（扫描只检查 .git 存在性，直接建目录即可）
    fs::create_dir_all(root.join(".git")).unwrap();
    // 一级子仓库
    fs::create_dir_all(root.join("sub-repo-a").join(".git")).unwrap();
    // 二级子仓库
    fs::create_dir_all(root.join("tools").join("sub-repo-c").join(".git")).unwrap();
    // node_modules 内的假仓库：命中排除表，不收录
    fs::create_dir_all(root.join("node_modules").join("fake").join(".git")).unwrap();
    // 深度 4 的仓库：超出限深，不收录
    fs::create_dir_all(
        root.join("a")
            .join("b")
            .join("c")
            .join("deep4")
            .join(".git"),
    )
    .unwrap();

    let repos = scan_git_repository_paths(root, 3);
    let rels: Vec<&str> = repos.iter().map(|(rel, _)| rel.as_str()).collect();

    assert_eq!(rels.first(), Some(&""), "根仓库应为首条（相对路径空串）");
    assert!(rels.contains(&"sub-repo-a"));
    assert!(rels.contains(&"tools/sub-repo-c"));
    assert!(!rels.iter().any(|r| r.contains("node_modules")));
    assert!(!rels.iter().any(|r| r.contains("deep4")));
    assert_eq!(rels.len(), 3);
}

#[test]
// 验证变更收集保留普通未跟踪文件并跳过嵌套仓库目录。
fn collect_git_changes_skips_nested_repo_dir() {
    let temp = tempfile::tempdir().unwrap();
    let repo = Repository::init(temp.path()).unwrap();

    // 普通未跟踪文件：应出现在变更列表中
    fs::write(temp.path().join("untracked.txt"), "hello\n").unwrap();

    // 嵌套子仓库（非 submodule）：目录条目应被跳过
    let nested = temp.path().join("sub-repo-a");
    fs::create_dir_all(&nested).unwrap();
    Repository::init(&nested).unwrap();
    fs::write(nested.join("inner.txt"), "inner\n").unwrap();

    let changes = collect_git_changes_from_repo(&repo).unwrap();
    let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();

    assert!(paths.contains(&"untracked.txt"));
    assert!(!paths.iter().any(|p| p.starts_with("sub-repo-a")));
}

#[test]
// 验证超大未跟踪文件使快照补丁截断，但仍保留脏状态和文件记录。
fn worktree_snapshot_bounds_large_untracked_patch() {
    let (_temp, repo_path) = init_temp_repo();
    let large_file = Path::new(&repo_path).join("large.txt");
    fs::write(
        &large_file,
        vec![b'x'; MAX_WORKTREE_PATCH_BYTES.saturating_add(1024)],
    )
    .unwrap();

    let repo = Repository::open(&repo_path).unwrap();
    let snapshot = build_worktree_snapshot(&repo_path, &repo).unwrap();

    assert!(snapshot.patch_truncated);
    assert!(snapshot.patch.is_empty());
    assert!(snapshot.dirty);
    assert!(snapshot.files.iter().any(|file| file.path == "large.txt"));
}

#[test]
// 验证嵌套仓库判断只命中带尾斜杠且含 .git 的目录。
fn is_nested_repo_entry_detects_nested_repo_dir_only() {
    let temp = tempfile::tempdir().unwrap();
    let repo = Repository::init(temp.path()).unwrap();

    // 嵌套子仓库目录（尾部 '/' 且含 .git）→ true
    let nested = temp.path().join("sub-repo-a");
    fs::create_dir_all(&nested).unwrap();
    Repository::init(&nested).unwrap();
    assert!(is_nested_repo_entry(&repo, "sub-repo-a/"));

    // 普通文件路径 → false
    fs::write(temp.path().join("untracked.txt"), "hello\n").unwrap();
    assert!(!is_nested_repo_entry(&repo, "untracked.txt"));

    // 无 .git 的普通目录路径 → false
    fs::create_dir_all(temp.path().join("plain-dir")).unwrap();
    assert!(!is_nested_repo_entry(&repo, "plain-dir/"));
}

#[test]
// 验证仓库相对路径接受普通嵌套文件名。
fn accepts_normal_relative_path() {
    assert!(validate_repo_relative_path("src/main.rs").is_ok());
    assert!(validate_repo_relative_path("a/b/c.txt").is_ok());
}

#[test]
// 验证分支名接受功能分支与远程跟踪形式。
fn accepts_valid_branch_names() {
    assert!(validate_branch_name("feature/git-panel").is_ok());
    assert!(validate_branch_name("origin/main").is_ok());
}

#[test]
// 验证分支名拒绝空值、选项前缀和非法路径字符。
fn rejects_invalid_branch_names() {
    assert_eq!(validate_branch_name("").unwrap_err(), "empty_branch");
    assert_eq!(validate_branch_name("-bad").unwrap_err(), "invalid_branch");
    assert_eq!(
        validate_branch_name("bad branch").unwrap_err(),
        "invalid_branch"
    );
    assert_eq!(
        validate_branch_name("bad..branch").unwrap_err(),
        "invalid_branch"
    );
    assert_eq!(
        validate_branch_name("bad:branch").unwrap_err(),
        "invalid_branch"
    );
    assert_eq!(
        validate_branch_name("bad\\branch").unwrap_err(),
        "invalid_branch"
    );
    assert_eq!(validate_branch_name("bad/").unwrap_err(), "invalid_branch");
}

#[test]
// 验证识别无改动可 stash 的输出而不误判成功创建 stash。
fn detects_no_stash_created_output() {
    assert!(is_no_stash_created("No local changes to save"));
    assert!(is_no_stash_created("no local changes"));
    assert!(!is_no_stash_created(
        "Saved working directory and index state"
    ));
}

#[test]
// 验证只在状态数量严格超过阈值时跳过行数统计。
fn skips_diff_line_stats_only_after_status_limit() {
    assert!(!should_skip_diff_line_stats(
        GIT_DIFF_LINE_STATS_STATUS_LIMIT
    ));
    assert!(should_skip_diff_line_stats(
        GIT_DIFF_LINE_STATS_STATUS_LIMIT + 1
    ));
}

#[test]
// 验证 WSL Git 参数包含仅针对当前仓库的 safe.directory。
fn wsl_git_args_include_repo_safe_directory() {
    let args =
        build_wsl_git_command_args("Ubuntu-22.04", "/data/tabGo", &["status", "--porcelain=v1"]);

    assert_eq!(
        args,
        vec![
            "-d",
            "Ubuntu-22.04",
            "--exec",
            "git",
            "-c",
            "safe.directory=/data/tabGo",
            "-C",
            "/data/tabGo",
            "status",
            "--porcelain=v1",
        ]
    );
}

#[test]
// 验证中英文非仓库提示可识别，而所有权错误不误归类。
fn recognizes_wsl_non_git_repository_errors() {
    assert!(is_not_git_repository_output(
        "fatal: not a git repository (or any of the parent directories): .git"
    ));
    assert!(is_not_git_repository_output(
        "致命错误：不是一个 Git 仓库（或者任何父目录）：.git"
    ));
    assert!(!is_not_git_repository_output(
        "fatal: detected dubious ownership in repository"
    ));
}

#[test]
// 验证 libgit2 NotFound 映射稳定非仓库码且保留所有权错误。
fn maps_libgit2_not_found_to_stable_non_repository_code() {
    let not_found = git2::Error::new(
        git2::ErrorCode::NotFound,
        git2::ErrorClass::Repository,
        "could not find repository at 'F:\\github\\demo'",
    );
    let mapped = format_open_repo_error(&not_found);
    assert!(is_not_git_repository_error(&mapped));
    assert!(mapped.starts_with(NOT_GIT_REPOSITORY_CODE));

    // 所有权误判、权限不足等真实故障不得被归类成「不是 Git 仓库」。
    let owner_error = git2::Error::new(
        git2::ErrorCode::Owner,
        git2::ErrorClass::Config,
        "detected dubious ownership in repository",
    );
    let owner_mapped = format_open_repo_error(&owner_error);
    assert!(!is_not_git_repository_error(&owner_mapped));
    assert!(owner_mapped.contains("detected dubious ownership"));
}

#[test]
// 验证普通临时目录的 Git 状态查询返回稳定非仓库错误码。
fn native_git_changes_reports_stable_code_for_plain_directory() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("plain.txt"), "no repo here\n").unwrap();

    let error = git_get_changes_native(&temp.path().to_string_lossy(), std::time::Instant::now())
        .expect_err("普通目录必须返回非 Git 仓库错误");

    assert_eq!(error, NOT_GIT_REPOSITORY_CODE);
}

#[test]
// 验证干净临时仓库的原生 Git 状态查询返回空列表。
fn native_git_changes_succeeds_inside_repository() {
    let (_temp, repo_path) = init_temp_repo();

    let changes = git_get_changes_native(&repo_path, std::time::Instant::now())
        .expect("仓库路径必须正常返回变更列表");

    assert!(changes.is_empty());
}

#[test]
// 验证 WSL 状态解析修改、新增、删除及未跟踪条目的暂存标记。
fn parses_wsl_git_status_basic_entries() {
    let input = b" M src/main.rs\0M  src/lib.rs\0A  added.txt\0 D deleted.txt\0?? notes/new.md\0?? generated/\0";
    let changes = parse_wsl_git_status(input);

    assert_eq!(changes.len(), 6);
    assert_eq!(changes[0].path, "src/main.rs");
    assert_eq!(changes[0].status, "M");
    assert!(!changes[0].staged);
    assert_eq!(changes[1].path, "src/lib.rs");
    assert_eq!(changes[1].status, "M");
    assert!(changes[1].staged);
    assert_eq!(changes[2].status, "A");
    assert!(changes[2].staged);
    assert_eq!(changes[3].status, "D");
    assert!(!changes[3].staged);
    assert_eq!(changes[4].status, "U");
    assert!(!changes[4].staged);
    assert_eq!(changes[5].path, "generated/");
    assert_eq!(changes[5].status, "U");
    assert!(!changes[5].staged);
}

#[test]
// 验证 WSL 状态解析跳过重命名原路径并识别冲突状态。
fn parses_wsl_git_status_rename_and_conflict() {
    let input = b"R  new/name.rs\0old/name.rs\0UU conflicted.txt\0";
    let changes = parse_wsl_git_status(input);

    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].path, "new/name.rs");
    assert_eq!(changes[0].status, "R");
    assert!(changes[0].staged);
    assert_eq!(changes[1].path, "conflicted.txt");
    assert_eq!(changes[1].status, "C");
    assert!(!changes[1].staged);
}

#[test]
// 验证 WSL 行数统计解析文本增删行并将二进制标记视为零。
fn parses_wsl_numstat_records() {
    let stats = parse_wsl_numstat(b"12\t3\tsrc/main.rs\0-\t-\tassets/logo.png\0");

    assert_eq!(stats.get("src/main.rs"), Some(&(12, 3)));
    assert_eq!(stats.get("assets/logo.png"), Some(&(0, 0)));
}

#[test]
// 验证仓库相对路径拒绝父目录越界片段。
fn rejects_parent_escape() {
    assert_eq!(
        validate_repo_relative_path("../etc/passwd").unwrap_err(),
        "path_escape"
    );
    assert_eq!(
        validate_repo_relative_path("src/../../x").unwrap_err(),
        "path_escape"
    );
}

#[test]
// 验证仓库相对路径拒绝 Unix、盘符及反斜杠绝对路径。
fn rejects_absolute_path() {
    assert_eq!(
        validate_repo_relative_path("/etc/passwd").unwrap_err(),
        "absolute_path"
    );
    assert_eq!(
        validate_repo_relative_path("C:/Windows").unwrap_err(),
        "absolute_path"
    );
    assert_eq!(
        validate_repo_relative_path("\\server\\share").unwrap_err(),
        "absolute_path"
    );
}

#[test]
// 验证仓库相对路径拒绝空文本。
fn rejects_empty() {
    assert_eq!(validate_repo_relative_path("").unwrap_err(), "empty_path");
}

#[test]
// 验证未跟踪快照文件删除拒绝父目录越界路径。
fn remove_untracked_snapshot_file_rejects_path_escape() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(
        remove_untracked_snapshot_file(temp.path(), "../outside.txt").unwrap_err(),
        "path_escape"
    );
}

#[test]
// 验证删除根内未跟踪文件后清理其空父目录。
fn remove_untracked_snapshot_file_removes_file_inside_workdir() {
    let temp = tempfile::tempdir().unwrap();
    let nested = temp.path().join("tmp").join("note.txt");
    fs::create_dir_all(nested.parent().unwrap()).unwrap();
    fs::write(&nested, "draft").unwrap();

    remove_untracked_snapshot_file(temp.path(), "tmp/note.txt").unwrap();

    assert!(!nested.exists());
    assert!(!temp.path().join("tmp").exists());
}

#[tokio::test]
// 验证未跟踪删除命令移除临时仓库中的未跟踪文件。
async fn git_delete_untracked_paths_removes_untracked_file() {
    let (temp, repo_path) = init_temp_repo();
    let untracked = temp.path().join("note.txt");
    fs::write(&untracked, "draft").unwrap();

    git_delete_untracked_paths(repo_path, vec!["note.txt".to_string()])
        .await
        .unwrap();

    assert!(!untracked.exists());
}

#[tokio::test]
// 验证未跟踪删除命令拒绝已跟踪文件。
async fn git_delete_untracked_paths_rejects_tracked_file() {
    let (_temp, repo_path) = init_temp_repo();

    let err = git_delete_untracked_paths(repo_path, vec!["tracked.txt".to_string()])
        .await
        .unwrap_err();

    assert_eq!(err, "path_not_untracked");
}

#[test]
// 验证快照分支名称接受普通层级名称并拒绝非法名称。
fn validate_snapshot_branch_name_rejects_invalid_names() {
    assert!(validate_snapshot_branch_name("replay/test").is_ok());
    assert_eq!(
        validate_snapshot_branch_name("../main").unwrap_err(),
        "branch_name_invalid"
    );
    assert_eq!(
        validate_snapshot_branch_name("bad branch").unwrap_err(),
        "branch_name_invalid"
    );
    assert_eq!(
        validate_snapshot_branch_name("").unwrap_err(),
        "branch_name_empty"
    );
}

#[tokio::test]
// 验证快照恢复在目标 HEAD 不匹配时拒绝执行。
async fn restore_worktree_snapshot_rejects_head_mismatch() {
    let (_temp, repo_path) = init_temp_repo();
    fs::write(Path::new(&repo_path).join("tracked.txt"), "target\n").unwrap();
    let (_head, patch) = snapshot_patch(&repo_path);

    let err = git_restore_worktree_snapshot(
        repo_path,
        patch.clone(),
        patch,
        "0000000000000000000000000000000000000000".to_string(),
    )
    .await
    .unwrap_err();

    assert_eq!(err, "head_mismatch");
}

#[tokio::test]
// 验证快照恢复在工作区已偏离预期补丁时拒绝执行。
async fn restore_worktree_snapshot_rejects_changed_worktree() {
    let (_temp, repo_path) = init_temp_repo();
    let file = Path::new(&repo_path).join("tracked.txt");
    fs::write(&file, "target\n").unwrap();
    let (head, target_patch) = snapshot_patch(&repo_path);
    fs::write(&file, "current\n").unwrap();

    let err = git_restore_worktree_snapshot(repo_path, target_patch.clone(), target_patch, head)
        .await
        .unwrap_err();

    assert_eq!(err, "worktree_changed_since_snapshot");
}

#[tokio::test]
// 验证快照恢复将当前工作区改动替换为目标补丁。
async fn restore_worktree_snapshot_restores_target_patch() {
    let (_temp, repo_path) = init_temp_repo();
    let file = Path::new(&repo_path).join("tracked.txt");
    fs::write(&file, "target\n").unwrap();
    let (head, target_patch) = snapshot_patch(&repo_path);
    fs::write(&file, "current\n").unwrap();
    let (_current_head, current_patch) = snapshot_patch(&repo_path);

    git_restore_worktree_snapshot(repo_path.clone(), target_patch, current_patch, head)
        .await
        .unwrap();

    assert_eq!(tracked_file(&repo_path), "target\n");
}

#[tokio::test]
// 验证快照分叉创建并切换目标分支后恢复指定补丁。
async fn fork_worktree_snapshot_creates_branch_and_restores_target_patch() {
    let (_temp, repo_path) = init_temp_repo();
    let file = Path::new(&repo_path).join("tracked.txt");
    fs::write(&file, "target\n").unwrap();
    let (head, target_patch) = snapshot_patch(&repo_path);
    fs::write(&file, "current\n").unwrap();
    let (_current_head, current_patch) = snapshot_patch(&repo_path);

    git_fork_worktree_snapshot(
        repo_path.clone(),
        target_patch,
        current_patch,
        head,
        "replay/test-fork".to_string(),
    )
    .await
    .unwrap();

    assert_eq!(current_branch(&repo_path), "replay/test-fork");
    assert_eq!(tracked_file(&repo_path), "target\n");
}

const SAMPLE_DIFF: &str = "\
diff --git a/foo.txt b/foo.txt
index 1111111..2222222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@
 line1
-old2
+new2
 line3
@@ -10,2 +10,3 @@
 line10
+inserted
 line11
";

#[test]
// 验证反向补丁仅包含首个 hunk，交换增删行且保留上下文。
fn reverses_first_hunk_only() {
    let patch = build_reverse_hunk_patch(SAMPLE_DIFF, 0).unwrap();
    // 文件头保留
    assert!(patch.contains("--- a/foo.txt"));
    assert!(patch.contains("+++ b/foo.txt"));
    // 对称 hunk，行号区间不变
    assert!(patch.contains("@@ -1,3 +1,3 @@"));
    // +/- 互换：原 -old2 → +old2，原 +new2 → -new2
    assert!(patch.contains("+old2"));
    assert!(patch.contains("-new2"));
    // 上下文保留
    assert!(patch.contains(" line1"));
    // 仅含第 0 个 hunk，不含第 1 个 hunk
    assert!(!patch.contains("inserted"));
    assert!(patch.ends_with('\n'));
}

#[test]
// 验证第二个 hunk 反转后交换行数并排除首个 hunk。
fn reverses_second_hunk_and_swaps_counts() {
    let patch = build_reverse_hunk_patch(SAMPLE_DIFF, 1).unwrap();
    // 原 @@ -10,2 +10,3 @@ 反向为 @@ -10,3 +10,2 @@
    assert!(patch.contains("@@ -10,3 +10,2 @@"));
    // 原 +inserted → -inserted
    assert!(patch.contains("-inserted"));
    // 不含第 0 个 hunk 的内容
    assert!(!patch.contains("new2"));
}

#[test]
// 验证反向 hunk 构建拒绝超出范围的序号。
fn rejects_out_of_range_hunk() {
    let err = build_reverse_hunk_patch(SAMPLE_DIFF, 5).unwrap_err();
    assert!(err.starts_with("hunk_index_out_of_range"));
}

#[test]
// 验证省略行数的单行 hunk 头按数量一处理。
fn handles_omitted_count_in_header() {
    // 单行变更，count 省略：@@ -5 +5 @@
    let diff = "--- a/x\n+++ b/x\n@@ -5 +5 @@\n-a\n+b\n";
    let patch = build_reverse_hunk_patch(diff, 0).unwrap();
    // 省略 count 视为 1，反向后为 @@ -5,1 +5,1 @@
    assert!(patch.contains("@@ -5,1 +5,1 @@"));
    assert!(patch.contains("+a"));
    assert!(patch.contains("-b"));
}

#[test]
// 验证行级回滚只删除选中的新增行，不恢复未选中的删除行。
fn line_revert_removes_selected_insert_only() {
    // 仅选中新增行 new2（new 行号 2）：删除 new2，但不恢复未选中的 old2。
    let sel = vec![("new".to_string(), 2u32)];
    let patch = build_reverse_lines_patch(SAMPLE_DIFF, &sel).unwrap();
    assert!(patch.contains("@@ -1,3 +1,2 @@"));
    assert!(patch.contains("-new2"));
    assert!(patch.contains(" line1"));
    assert!(patch.contains(" line3"));
    // old2 未选中 → 省略
    assert!(!patch.contains("old2"));
}

#[test]
// 验证行级回滚只恢复选中的删除行，并保留未选中的新增行。
fn line_revert_restores_selected_delete_only() {
    // 仅选中删除行 old2（old 行号 2）：恢复 old2，未选中的 new2 降为上下文保留。
    let sel = vec![("old".to_string(), 2u32)];
    let patch = build_reverse_lines_patch(SAMPLE_DIFF, &sel).unwrap();
    assert!(patch.contains("@@ -1,3 +1,4 @@"));
    assert!(patch.contains("+old2"));
    assert!(patch.contains(" new2"));
}

#[test]
// 验证行级回滚跳过没有选中行的 hunk。
fn line_revert_skips_hunks_without_selection() {
    // 仅选中第二个 hunk 的 inserted（new 行号 11）：只反向第二个 hunk。
    let sel = vec![("new".to_string(), 11u32)];
    let patch = build_reverse_lines_patch(SAMPLE_DIFF, &sel).unwrap();
    assert!(patch.contains("@@ -10,3 +10,2 @@"));
    assert!(patch.contains("-inserted"));
    // 第一个 hunk 无选中 → 跳过
    assert!(!patch.contains("@@ -1,"));
    assert!(!patch.contains("new2"));
}

#[test]
// 验证选择行号不匹配任何变更时返回无选中行错误。
fn line_revert_no_match_errors() {
    let sel = vec![("new".to_string(), 999u32)];
    assert_eq!(
        build_reverse_lines_patch(SAMPLE_DIFF, &sel).unwrap_err(),
        "no_lines_selected"
    );
}
