use git2::Repository;
use std::borrow::Cow;
use std::path::Path;

use super::git::format_diff_to_text_allow_empty;
use super::git_diff::{
    build_diff_payload, GitDiffOptions, GitDiffWhitespaceMode, GitFileDiffPayload,
};
use crate::text_encoding::{decode_text, decode_text_fragment, is_utf8_encoding, DecodedText};

pub(super) fn format_cli_diff(
    bytes: &[u8],
    file_path: &str,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    let (content, utf8) = match std::str::from_utf8(bytes) {
        Ok(content) => (content.to_string(), true),
        Err(_) => (decode_text(bytes)?.content, false),
    };
    if content.is_empty() && options.whitespace == GitDiffWhitespaceMode::Exact {
        return Err(format!("文件 {file_path} 无变更"));
    }
    let binary = bytes.windows(13).any(|window| window == b"Binary files ");
    build_diff_payload(content, options.allows_partial_revert() && utf8 && !binary)
}

pub(super) fn detect_file_diff_encoding(
    repo: &Repository,
    workdir: &Path,
    file_path: &str,
) -> Result<Option<DecodedText>, String> {
    let worktree_path = workdir.join(file_path);
    let bytes = if worktree_path.is_file() {
        Some(std::fs::read(&worktree_path).map_err(|error| format!("读取文件失败: {error}"))?)
    } else {
        let head_tree = match repo.head().and_then(|head| head.peel_to_tree()) {
            Ok(tree) => tree,
            Err(_) => return Ok(None),
        };
        let entry = match head_tree.get_path(Path::new(file_path)) {
            Ok(entry) => entry,
            Err(_) => return Ok(None),
        };
        let blob = match repo.find_blob(entry.id()) {
            Ok(blob) => blob,
            Err(_) => return Ok(None),
        };
        Some(blob.content().to_vec())
    };

    match bytes.as_deref().map(decode_text) {
        Some(Ok(decoded)) => Ok(Some(decoded)),
        Some(Err("binary_file")) | None => Ok(None),
        Some(Err(error)) => Err(error.to_string()),
    }
}

pub(super) fn format_diff_for_display(
    diff: git2::Diff,
    file_path: &str,
    encoding_hint: Option<&DecodedText>,
    options: GitDiffOptions,
) -> Result<GitFileDiffPayload, String> {
    let detected_from_diff;
    let encoding = if let Some(hint) = encoding_hint {
        Some(hint)
    } else {
        let body = collect_diff_body_bytes(&diff)?;
        if body.is_empty() {
            None
        } else {
            detected_from_diff = decode_text(&body)?;
            Some(&detected_from_diff)
        }
    };

    let (content, encoding_allows_revert) = match encoding {
        None => (format_diff_to_text_allow_empty(&diff)?, true),
        Some(detected) if is_utf8_encoding(&detected.encoding) => {
            (format_diff_to_text_allow_empty(&diff)?, true)
        }
        Some(detected) => (
            format_diff_to_display_text(&diff, &detected.encoding, detected.has_bom)?,
            false,
        ),
    };
    if content.is_empty() && options.whitespace == GitDiffWhitespaceMode::Exact {
        return Err(format!("文件 {file_path} 无变更"));
    }
    log::debug!("[git_get_file_diff] diff 生成成功，长度: {}", content.len());
    build_diff_payload(
        content,
        options.allows_partial_revert() && encoding_allows_revert,
    )
}

fn collect_diff_body_bytes(diff: &git2::Diff) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            body.extend_from_slice(line.content());
        }
        true
    })
    .map_err(|error| format!("打印 diff 失败: {error}"))?;
    Ok(body)
}

fn format_diff_to_display_text(
    diff: &git2::Diff,
    encoding: &str,
    has_bom: bool,
) -> Result<String, String> {
    let mut display_text = String::new();
    let mut decode_error = None;
    let mut pending_utf16le_newline_byte = false;

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if decode_error.is_some() {
            return true;
        }
        if matches!(line.origin(), '+' | '-' | ' ') {
            let Some(fragment) = normalize_diff_body_fragment(
                line.content(),
                encoding,
                &mut pending_utf16le_newline_byte,
            ) else {
                return true;
            };
            display_text.push(line.origin());
            match decode_text_fragment(fragment.as_ref(), encoding, has_bom) {
                Ok(content) => display_text.push_str(&content),
                Err(error) => decode_error = Some(error),
            }
        } else {
            match std::str::from_utf8(line.content()) {
                Ok(content) => display_text.push_str(content),
                Err(_) => decode_error = Some("text_decode_failed"),
            }
        }
        true
    })
    .map_err(|error| format!("打印 diff 失败: {error}"))?;

    match decode_error {
        Some(error) => Err(error.to_string()),
        None => Ok(display_text),
    }
}

fn normalize_diff_body_fragment<'a>(
    bytes: &'a [u8],
    encoding: &str,
    pending_utf16le_newline_byte: &mut bool,
) -> Option<Cow<'a, [u8]>> {
    if !encoding.eq_ignore_ascii_case("utf-16le") {
        return Some(Cow::Borrowed(bytes));
    }
    let mut input = bytes;
    if *pending_utf16le_newline_byte && input.first() == Some(&0) {
        input = &input[1..];
    }
    *pending_utf16le_newline_byte = false;
    if input.is_empty() {
        return None;
    }
    if input.last() == Some(&b'\n') {
        *pending_utf16le_newline_byte = true;
    }
    if input.len() % 2 == 1 && input.last() == Some(&b'\n') {
        let mut normalized = Vec::with_capacity(input.len() + 1);
        normalized.extend_from_slice(input);
        normalized.push(0);
        return Some(Cow::Owned(normalized));
    }
    Some(Cow::Borrowed(input))
}
