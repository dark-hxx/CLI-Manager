use serde::{Deserialize, Serialize};
use std::path::Path;

use super::git::{
    open_git_repo, resolve_wsl_mnt_git_project_path, run_wsl_git, validate_repo_relative_path,
};
use super::git_diff_display::{
    detect_file_diff_encoding, format_cli_diff, format_diff_for_display,
};
use crate::text_encoding::decode_text;

pub(super) const MAX_DIFF_BYTES: usize = 768 * 1024;
pub(super) const MAX_DIFF_LINES: usize = 20_000;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitDiffWhitespaceMode {
    Exact,
    IgnoreEol,
    IgnoreAll,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffOptions {
    pub whitespace: GitDiffWhitespaceMode,
    pub context_lines: u32,
}

impl Default for GitDiffOptions {
    // 默认按精确空白生成三行上下文的 Diff。
    fn default() -> Self {
        Self {
            whitespace: GitDiffWhitespaceMode::Exact,
            context_lines: 3,
        }
    }
}

impl GitDiffOptions {
    // 仅允许三、十或二十行上下文选项。
    pub fn validate(self) -> Result<Self, String> {
        if matches!(self.context_lines, 3 | 10 | 20) {
            Ok(self)
        } else {
            Err("git_diff_options_invalid".to_string())
        }
    }

    // 只有精确空白模式允许后续考虑局部回滚。
    pub(super) fn allows_partial_revert(self) -> bool {
        self.whitespace == GitDiffWhitespaceMode::Exact
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffPayload {
    pub content: String,
    pub can_revert_hunks: bool,
    pub byte_length: usize,
    pub line_count: usize,
}

// 统计 UTF-8 字节和文本行数，超过展示上限即拒绝，不截断 Patch。
pub(super) fn build_diff_payload(
    content: String,
    can_revert_hunks: bool,
) -> Result<GitFileDiffPayload, String> {
    let byte_length = content.len();
    let line_count = content.lines().count();
    if byte_length > MAX_DIFF_BYTES || line_count > MAX_DIFF_LINES {
        return Err("git_diff_too_large".to_string());
    }
    Ok(GitFileDiffPayload {
        content,
        can_revert_hunks,
        byte_length,
        line_count,
    })
}

// 验证相对路径并按本地或 WSL 运行环境选择 Diff 生成方式。
pub(super) fn get_file_diff(
    project_path: &str,
    file_path: &str,
    status: &str,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    validate_repo_relative_path(file_path)?;

    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(project_path) {
        if let Some(windows_path) = resolve_wsl_mnt_git_project_path(&distro, &linux_path) {
            return get_native_diff(Path::new(&windows_path), file_path, status, options);
        }
        return get_wsl_diff(
            project_path,
            &distro,
            &linux_path,
            file_path,
            status,
            options,
        );
    }

    let root = Path::new(project_path);
    if !root.exists() {
        return Err(format!("路径不存在: {project_path}"));
    }
    get_native_diff(root, file_path, status, options)
}

// 为未跟踪文件生成全新增 Diff，否则按状态及编码选项构造 libgit2 Diff。
fn get_native_diff(
    root: &Path,
    file_path: &str,
    status: &str,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    if matches!(status, "U" | "??") {
        return untracked_diff(root, file_path);
    }

    let repo = open_git_repo(root).map_err(|error| format!("打开仓库失败: {error}"))?;
    let encoding = detect_file_diff_encoding(&repo, root, file_path)?;
    let mut diff_options = git2::DiffOptions::new();
    diff_options.pathspec(file_path);
    diff_options.context_lines(options.context_lines);
    diff_options.force_text(encoding.is_some());
    match options.whitespace {
        GitDiffWhitespaceMode::Exact => {}
        GitDiffWhitespaceMode::IgnoreEol => {
            diff_options.ignore_whitespace_eol(true);
        }
        GitDiffWhitespaceMode::IgnoreAll => {
            diff_options.ignore_whitespace(true);
        }
    }

    let diff = if status == "A" {
        repo.diff_index_to_workdir(None, Some(&mut diff_options))
            .map_err(|error| format!("生成 diff 失败: {error}"))?
    } else {
        let head = repo
            .head()
            .map_err(|error| format!("获取 HEAD 失败: {error}"))?;
        let head_tree = head
            .peel_to_tree()
            .map_err(|error| format!("获取 HEAD tree 失败: {error}"))?;
        repo.diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut diff_options))
            .map_err(|error| format!("生成 diff 失败: {error}"))?
    };

    format_diff_for_display(diff, file_path, encoding.as_ref(), options)
}

// 未跟踪文件通过 UNC 读取，已跟踪文件通过 WSL Git 生成展示 Diff。
fn get_wsl_diff(
    unc_root: &str,
    distro: &str,
    linux_root: &str,
    file_path: &str,
    status: &str,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    if matches!(status, "U" | "??") {
        return untracked_diff(Path::new(unc_root), file_path);
    }

    let args = cli_diff_args(file_path, status, options);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let bytes = run_wsl_git(distro, linux_root, &refs)?;
    format_cli_diff(&bytes, file_path, options)
}

// 构造关闭外部 Diff、textconv 和颜色的参数，并应用空白、上下文及路径选项。
fn cli_diff_args(file_path: &str, status: &str, options: GitDiffOptions) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        "diff.external=".to_string(),
        "-c".to_string(),
        "pager.diff=false".to_string(),
        "-c".to_string(),
        "core.quotepath=false".to_string(),
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-textconv".to_string(),
        "--no-color".to_string(),
        format!("--unified={}", options.context_lines),
    ];
    match options.whitespace {
        GitDiffWhitespaceMode::Exact => {}
        GitDiffWhitespaceMode::IgnoreEol => args.push("--ignore-space-at-eol".to_string()),
        GitDiffWhitespaceMode::IgnoreAll => args.push("--ignore-all-space".to_string()),
    }
    if status != "A" {
        args.push("HEAD".to_string());
    }
    args.extend(["--".to_string(), file_path.to_string()]);
    args
}

// 拒绝目录，解码文件并生成全新增只读 Diff，再检查展示长度限制。
fn untracked_diff(root: &Path, file_path: &str) -> Result<GitFileDiffPayload, String> {
    let full_path = root.join(file_path);
    if full_path.is_dir() {
        return Err("该条目是目录（可能为嵌套 Git 仓库），无法显示文件 diff".to_string());
    }
    let bytes = std::fs::read(&full_path).map_err(|error| format!("读取文件失败: {error}"))?;
    let content = decode_text(&bytes)?.content;
    let line_count = content.lines().count();
    let mut diff = format!(
        "diff --git a/{file_path} b/{file_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{file_path}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in content.lines() {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    build_diff_payload(diff, false)
}

#[cfg(test)]
#[path = "diff_tests.rs"]
mod tests;
