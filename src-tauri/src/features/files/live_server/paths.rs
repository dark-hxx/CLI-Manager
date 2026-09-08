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

// 校验绝对项目路径并规范分隔符及尾斜杠，Windows 下转小写作为注册键。
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

// 拒绝 WSL，校验 HTML 相对入口及规范路径在项目根内且为文件。
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
// 打开目录能力句柄后复核根路径未解析到不同目标。
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
// 百分号解码请求路径，补目录默认 index.html 并验证安全相对路径。
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

// 逐路径段百分号编码并保留目录分隔符，构造页面 URL。
pub fn build_page_url(origin: &str, relative_path: &str) -> String {
    let encoded = relative_path
        .split('/')
        .map(|segment| utf8_percent_encode(segment, URL_SEGMENT_ENCODE_SET).to_string())
        .collect::<Vec<_>>()
        .join("/");
    format!("{origin}/{encoded}")
}

// 要求项目路径绝对，解析规范路径并确认其为目录。
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

// 解析根下入口真实路径并检查未越出项目根。
fn canonical_entry(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let canonical = root
        .join(relative_path)
        .canonicalize()
        .map_err(|_| "entry_not_found".to_string())?;
    ensure_within_root(root, &canonical)?;
    Ok(canonical)
}

// 拒绝空路径、绝对路径及反斜杠，再验证各路径段。
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

// 拒绝当前目录、父目录及空路径段。
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

// 去掉一个 URL 前导斜杠并将百分号编码解码为 UTF-8 文本。
fn decode_request_path(request_path: &str) -> Result<String, String> {
    let encoded = request_path.strip_prefix('/').unwrap_or(request_path);
    percent_decode_str(encoded)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| "invalid_url_encoding".to_string())
}

// 按路径组件前缀确认目标位于项目根内。
fn ensure_within_root(root: &Path, path: &Path) -> Result<(), String> {
    if path.starts_with(root) {
        return Ok(());
    }
    Err("path_outside_root".to_string())
}

// 不区分 ASCII 大小写识别 html 或 htm 扩展名。
fn is_html_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| HTML_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests;
