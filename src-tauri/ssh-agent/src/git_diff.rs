use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::git::{
    resolve_repo, run_git, validate_file_path, GitOutput, MAX_DIFF_BYTES, READ_TIMEOUT,
};

const MAX_DIFF_LINES: usize = 20_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiffRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub relative_path: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitDiffWhitespaceMode {
    Exact,
    IgnoreEol,
    IgnoreAll,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffOptions {
    pub whitespace: GitDiffWhitespaceMode,
    pub context_lines: u32,
}

impl Default for GitDiffOptions {
    fn default() -> Self {
        Self {
            whitespace: GitDiffWhitespaceMode::Exact,
            context_lines: 3,
        }
    }
}

impl GitDiffOptions {
    fn validate(self) -> Result<Self, String> {
        if matches!(self.context_lines, 3 | 10 | 20) {
            Ok(self)
        } else {
            Err("remote_git_diff_options_invalid".to_string())
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiffWithOptionsRequest {
    pub root_path: String,
    #[serde(default)]
    pub repo_path: String,
    pub relative_path: String,
    #[serde(default)]
    pub status: String,
    pub options: GitDiffOptions,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffPayload {
    pub content: String,
    pub can_revert_hunks: bool,
    pub byte_length: usize,
    pub line_count: usize,
}

fn build_diff_payload(
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

pub(super) fn legacy_diff(request: DiffRequest) -> Result<GitFileDiffPayload, String> {
    diff(request, GitDiffOptions::default(), true)
}

pub(super) fn diff_with_options(
    request: DiffWithOptionsRequest,
) -> Result<GitFileDiffPayload, String> {
    let options = request.options.validate()?;
    diff(
        DiffRequest {
            root_path: request.root_path,
            repo_path: request.repo_path,
            relative_path: request.relative_path,
            status: request.status,
        },
        options,
        false,
    )
}

fn diff(
    request: DiffRequest,
    options: GitDiffOptions,
    legacy: bool,
) -> Result<GitFileDiffPayload, String> {
    let (_, repo) = resolve_repo(&request.root_path, &request.repo_path)?;
    let path = validate_file_path(&repo, &request.relative_path)?;
    if matches!(request.status.as_str(), "U" | "??") {
        return untracked_diff(&repo, &path);
    }

    let args = diff_args(&path, &request.status, options, legacy);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_git(&repo, &refs, false, READ_TIMEOUT).or_else(|_| {
        let fallback = diff_args(&path, "A", options, false);
        let fallback_refs = fallback.iter().map(String::as_str).collect::<Vec<_>>();
        run_git(&repo, &fallback_refs, false, READ_TIMEOUT)
    })?;
    tracked_payload(output, options)
}

fn diff_args(path: &str, status: &str, options: GitDiffOptions, legacy: bool) -> Vec<String> {
    let mut args = vec![
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
    if legacy || status != "A" {
        args.push("HEAD".to_string());
    }
    args.extend(["--".to_string(), path.to_string()]);
    args
}

fn untracked_diff(repo: &Path, path: &str) -> Result<GitFileDiffPayload, String> {
    let target = repo.join(path);
    validate_untracked_target(&target)?;
    let bytes = fs::read(target).map_err(|_| "remote_git_file_read_failed")?;
    if bytes.len() > MAX_DIFF_BYTES {
        return Err("git_diff_too_large".to_string());
    }
    if bytes.contains(&0) {
        return build_diff_payload(
            format!(
                "diff --git a/{path} b/{path}\nnew file mode 100644\nBinary files /dev/null and b/{path} differ\n"
            ),
            false,
        );
    }
    let (text, _) = decode_diff_text(&bytes);
    let line_count = text.lines().count();
    let mut content = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n"
    );
    for line in text.lines() {
        content.push('+');
        content.push_str(line);
        content.push('\n');
    }
    build_diff_payload(content, false)
}

fn tracked_payload(
    output: GitOutput,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    if output.stdout.len() > MAX_DIFF_BYTES {
        return Err("git_diff_too_large".to_string());
    }
    let (content, utf8) = decode_diff_text(&output.stdout);
    if content.is_empty() && options.whitespace == GitDiffWhitespaceMode::Exact {
        return Err("remote_git_diff_empty".to_string());
    }
    let binary = output
        .stdout
        .windows(13)
        .any(|part| part == b"Binary files ");
    build_diff_payload(
        content,
        options.whitespace == GitDiffWhitespaceMode::Exact && utf8 && !binary,
    )
}

fn decode_diff_text(bytes: &[u8]) -> (String, bool) {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), true);
    }
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    let encoding = detector.guess(None, Utf8Detection::Allow);
    let (text, _, _) = encoding.decode(bytes);
    (text.into_owned(), false)
}

fn validate_untracked_target(target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(target).map_err(|_| "remote_git_file_read_failed")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("remote_git_symlink_rejected".to_string());
    }
    Ok(())
}

#[cfg(test)]
#[path = "git_diff_tests.rs"]
mod tests;
