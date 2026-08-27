use std::path::{Path, PathBuf};

use cap_std::{ambient_authority, fs::Dir};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};

const HTML_EXTENSIONS: &[&str] = &["htm", "html"];
const URL_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b':')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug)]
pub struct ValidatedStartRequest {
    pub registry_key: String,
    pub root: PathBuf,
    pub relative_path: String,
}

pub fn registry_key(project_path: &str) -> Result<String, String> {
    let trimmed = project_path.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err("root_not_absolute".to_string());
    }
    let normalized = trimmed.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        return Ok(normalized.to_lowercase());
    }
    Ok(normalized)
}

pub fn validate_start_request(
    project_path: &str,
    relative_path: &str,
) -> Result<ValidatedStartRequest, String> {
    if crate::wsl::is_wsl_config_dir(project_path) {
        return Err("wsl_live_server_unsupported".to_string());
    }
    validate_relative_path(relative_path)?;
    if !is_html_path(Path::new(relative_path)) {
        return Err("entry_not_html".to_string());
    }

    let root = canonical_root(project_path)?;
    let entry = canonical_entry(&root, relative_path)?;
    if !entry.is_file() {
        return Err("entry_not_found".to_string());
    }

    Ok(ValidatedStartRequest {
        registry_key: registry_key(project_path)?,
        root,
        relative_path: relative_path.to_string(),
    })
}

/// Opens the canonical project root and keeps the resulting directory handle as
/// the authority for all subsequent requests.  The handle pins the directory
/// entry, so replacing the root path after this point cannot redirect a request
/// to a different tree.
pub fn open_root_dir(root: &Path) -> Result<Dir, String> {
    let directory = Dir::open_ambient_dir(root, ambient_authority())
        .map_err(|error| format!("root_canonicalize_failed: {error}"))?;

    // `root` was canonicalized during start-up.  Re-check the path *after* the
    // handle is opened so a replacement of the root with a symlink/junction
    // before the open cannot silently change the served tree.
    let observed = root
        .canonicalize()
        .map_err(|error| format!("root_canonicalize_failed: {error}"))?;
    if observed != root {
        return Err("path_outside_root".to_string());
    }

    Ok(directory)
}

/// Resolves an HTTP URL path to a safe path relative to the capability root.
/// No ambient filesystem access occurs here; the caller must open the returned
/// path through the `Dir` returned by [`open_root_dir`].
pub fn resolve_request_path(request_path: &str) -> Result<PathBuf, String> {
    let decoded = decode_request_path(request_path)?;
    let relative = if decoded.is_empty() {
        "index.html".to_string()
    } else if decoded.ends_with('/') {
        format!("{decoded}index.html")
    } else {
        decoded
    };
    validate_relative_path(&relative)?;
    Ok(PathBuf::from(relative))
}

pub fn build_page_url(origin: &str, relative_path: &str) -> String {
    let encoded = relative_path
        .split('/')
        .map(|segment| utf8_percent_encode(segment, URL_SEGMENT_ENCODE_SET).to_string())
        .collect::<Vec<_>>()
        .join("/");
    format!("{origin}/{encoded}")
}

fn canonical_root(project_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(project_path.trim());
    if !path.is_absolute() {
        return Err("root_not_absolute".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("root_canonicalize_failed: {error}"))?;
    if !canonical.is_dir() {
        return Err("root_not_directory".to_string());
    }
    Ok(canonical)
}

fn canonical_entry(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let canonical = root
        .join(relative_path)
        .canonicalize()
        .map_err(|_| "entry_not_found".to_string())?;
    ensure_within_root(root, &canonical)?;
    Ok(canonical)
}

fn validate_relative_path(relative_path: &str) -> Result<(), String> {
    if relative_path.is_empty() {
        return Err("path_empty".to_string());
    }
    if relative_path.starts_with('/') || Path::new(relative_path).is_absolute() {
        return Err("path_is_absolute".to_string());
    }
    if relative_path.contains('\\') {
        return Err("path_contains_backslash".to_string());
    }
    validate_segments(relative_path)
}

fn validate_segments(relative_path: &str) -> Result<(), String> {
    for segment in relative_path.split('/') {
        match segment {
            "." => return Err("path_contains_current_segment".to_string()),
            ".." => return Err("path_contains_parent_segment".to_string()),
            "" => return Err("path_contains_empty_segment".to_string()),
            _ => {}
        }
    }
    Ok(())
}

fn decode_request_path(request_path: &str) -> Result<String, String> {
    let encoded = request_path.strip_prefix('/').unwrap_or(request_path);
    percent_decode_str(encoded)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| "invalid_url_encoding".to_string())
}

fn ensure_within_root(root: &Path, path: &Path) -> Result<(), String> {
    if path.starts_with(root) {
        return Ok(());
    }
    Err("path_outside_root".to_string())
}

fn is_html_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| HTML_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests;
