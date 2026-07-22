use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_ENTRIES: usize = 500;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_TEXT_READ_BYTES: u64 = 1024 * 1024;
const MAX_IMAGE_READ_BYTES: u64 = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 12_000_000;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;
const MAX_WALK_FILES: usize = 20_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListRequest {
    pub root_path: String,
    #[serde(default)]
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadRequest {
    pub root_path: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchRequest {
    pub root_path: String,
    pub query: String,
    #[serde(default)]
    pub content: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub modified_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileRead {
    pub relative_path: String,
    pub kind: String,
    pub content: String,
    pub size_bytes: u64,
    pub modified_ms: Option<i64>,
    pub truncated: bool,
}

pub fn list(request: FileListRequest) -> Result<Vec<RemoteFileEntry>, String> {
    let root = resolve_root(&request.root_path)?;
    let directory = resolve_relative(&root, &request.relative_path)?;
    if !directory.is_dir() {
        return Err("remote_file_not_directory".to_string());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|_| "remote_file_list_failed".to_string())? {
        let entry = entry.map_err(|_| "remote_file_list_failed".to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|_| "remote_file_list_failed".to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| "remote_file_metadata_failed".to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = relative_path(&root, &entry.path())?;
        entries.push(RemoteFileEntry {
            name,
            relative_path,
            kind: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            }
            .to_string(),
            size_bytes: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    entries.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .reverse()
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn read(request: FileReadRequest) -> Result<RemoteFileRead, String> {
    let root = resolve_root(&request.root_path)?;
    let path = resolve_relative(&root, &request.relative_path)?;
    let metadata = path
        .metadata()
        .map_err(|_| "remote_file_not_found".to_string())?;
    if !metadata.is_file() {
        return Err("remote_file_not_file".to_string());
    }
    if is_video(&path) {
        return Err("video_preview_unsupported".to_string());
    }
    let image = is_image(&path);
    let max_bytes = if image {
        MAX_IMAGE_READ_BYTES
    } else {
        MAX_TEXT_READ_BYTES
    };
    if metadata.len() > max_bytes {
        return Err(if image {
            "image_file_too_large".to_string()
        } else {
            "remote_file_too_large".to_string()
        });
    }
    if image {
        validate_image_dimensions(&path)?;
    }
    let bytes = fs::read(&path).map_err(|_| "remote_file_read_failed".to_string())?;
    let kind = if image { "image" } else { "text" };
    let content = if kind == "image" {
        format!(
            "data:{};base64,{}",
            image_mime(&path),
            base64_encode(&bytes)
        )
    } else {
        String::from_utf8(bytes).map_err(|_| "remote_file_binary".to_string())?
    };
    Ok(RemoteFileRead {
        relative_path: relative_path(&root, &path)?,
        kind: kind.to_string(),
        content,
        size_bytes: metadata.len(),
        modified_ms: modified_ms(&metadata),
        truncated: false,
    })
}

pub fn search(request: FileSearchRequest) -> Result<Vec<RemoteFileEntry>, String> {
    let query = request.query.trim().to_lowercase();
    if query.chars().count() < 2 || query.len() > 256 {
        return Ok(Vec::new());
    }
    let root = resolve_root(&request.root_path)?;
    let mut results = Vec::new();
    let mut visited = 0;
    walk_search(
        &root,
        &root,
        &query,
        request.content,
        &mut results,
        &mut visited,
        0,
    )?;
    Ok(results)
}

fn walk_search(
    root: &Path,
    directory: &Path,
    query: &str,
    content: bool,
    results: &mut Vec<RemoteFileEntry>,
    visited: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 || results.len() >= MAX_SEARCH_RESULTS || *visited >= MAX_WALK_FILES {
        return Ok(());
    }
    let entries = fs::read_dir(directory).map_err(|_| "remote_file_search_failed".to_string())?;
    for entry in entries {
        if results.len() >= MAX_SEARCH_RESULTS {
            break;
        }
        if *visited >= MAX_WALK_FILES {
            break;
        }
        *visited += 1;
        let entry = entry.map_err(|_| "remote_file_search_failed".to_string())?;
        let kind = entry
            .file_type()
            .map_err(|_| "remote_file_search_failed".to_string())?;
        if kind.is_symlink() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| "remote_file_metadata_failed".to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let name_match = name.to_lowercase().contains(query);
        let content_match = content
            && kind.is_file()
            && metadata.len() <= MAX_SEARCH_FILE_BYTES
            && fs::read(&path)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .is_some_and(|text| text.to_lowercase().contains(query));
        if name_match || content_match {
            results.push(RemoteFileEntry {
                name,
                relative_path: relative_path(root, &path)?,
                kind: if kind.is_dir() { "directory" } else { "file" }.to_string(),
                size_bytes: metadata.len(),
                modified_ms: modified_ms(&metadata),
            });
        }
        if kind.is_dir() {
            walk_search(root, &path, query, content, results, visited, depth + 1)?;
        }
    }
    Ok(())
}

fn resolve_root(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if !Path::new(value).is_absolute()
        || value.contains(['\0', '\r', '\n'])
        || (!cfg!(windows) && value.contains('\\'))
        || value.split('/').any(|part| part == "..")
    {
        return Err("remote_file_root_invalid".to_string());
    }
    let root = Path::new(value)
        .canonicalize()
        .map_err(|_| "remote_file_root_unavailable".to_string())?;
    if !root.is_dir() {
        return Err("remote_file_root_not_directory".to_string());
    }
    Ok(root)
}

fn resolve_relative(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains(['\0', '\r', '\n', '\\'])
        || Path::new(relative).is_absolute()
        || relative.split('/').any(|part| part == "..")
    {
        return Err("remote_file_path_invalid".to_string());
    }
    let path = root.join(relative);
    let canonical = path
        .canonicalize()
        .map_err(|_| "remote_file_not_found".to_string())?;
    if !canonical.starts_with(root) {
        return Err("remote_file_path_confined".to_string());
    }
    Ok(canonical)
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "remote_file_path_confined".to_string())
}

fn modified_ms(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_millis() as i64)
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
    )
}

fn is_video(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some(
            "3g2"
                | "3gp"
                | "avi"
                | "flv"
                | "m2ts"
                | "m4v"
                | "mkv"
                | "mov"
                | "mp4"
                | "mpeg"
                | "mpg"
                | "mts"
                | "ogv"
                | "ts"
                | "webm"
                | "wmv"
        )
    )
}

fn validate_image_dimensions(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        return Ok(());
    }
    let (width, height) =
        image::image_dimensions(path).map_err(|_| "remote_file_image_invalid".to_string())?;
    validate_image_pixel_count(width, height)
}

fn validate_image_pixel_count(width: u32, height: u32) -> Result<(), String> {
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err("image_dimensions_too_large".to_string());
    }
    Ok(())
}

fn image_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "image/png",
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or_default() as u32;
        let third = chunk.get(2).copied().unwrap_or_default() as u32;
        output.push(TABLE[((first >> 2) & 0x3f) as usize] as char);
        output.push(TABLE[(((first << 4) | (second >> 4)) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second << 2) | (third >> 6)) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{
        base64_encode, list, read, search, FileListRequest, FileReadRequest, FileSearchRequest,
        MAX_ENTRIES, MAX_SEARCH_RESULTS, MAX_TEXT_READ_BYTES,
    };
    use std::fs;

    #[test]
    fn base64_encoding_is_standard() {
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn paths_reject_traversal_and_absolute_relative_refs() {
        assert!(super::resolve_root("relative").is_err());
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        assert!(super::resolve_relative(&root, "../secret").is_err());
        assert!(super::resolve_relative(&root, "/etc/passwd").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_entries_are_hidden_and_cannot_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(
            outside.path().join("secret.txt"),
            root.path().join("escape.txt"),
        )
        .unwrap();
        let entries = list(FileListRequest {
            root_path: root.path().display().to_string(),
            relative_path: String::new(),
        })
        .unwrap();
        assert!(entries.is_empty());
        assert!(read(FileReadRequest {
            root_path: root.path().display().to_string(),
            relative_path: "escape.txt".into()
        })
        .is_err());
    }

    #[test]
    fn read_rejects_binary_and_oversized_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("binary.bin"), [0xff, 0xfe]).unwrap();
        fs::write(
            root.path().join("large.txt"),
            vec![b'a'; MAX_TEXT_READ_BYTES as usize + 1],
        )
        .unwrap();
        let root_path = root.path().display().to_string();
        assert_eq!(
            read(FileReadRequest {
                root_path: root_path.clone(),
                relative_path: "binary.bin".into()
            })
            .unwrap_err(),
            "remote_file_binary"
        );
        assert_eq!(
            read(FileReadRequest {
                root_path,
                relative_path: "large.txt".into()
            })
            .unwrap_err(),
            "remote_file_too_large"
        );
    }

    #[test]
    fn list_and_search_enforce_result_limits() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..(MAX_ENTRIES + 20) {
            fs::write(root.path().join(format!("match-{index:04}.txt")), "needle").unwrap();
        }
        let root_path = root.path().display().to_string();
        assert_eq!(
            list(FileListRequest {
                root_path: root_path.clone(),
                relative_path: String::new()
            })
            .unwrap()
            .len(),
            MAX_ENTRIES
        );
        assert_eq!(
            search(FileSearchRequest {
                root_path,
                query: "match".into(),
                content: false
            })
            .unwrap()
            .len(),
            MAX_SEARCH_RESULTS
        );
    }

    #[test]
    fn image_read_returns_data_url() {
        let root = tempfile::tempdir().unwrap();
        image::save_buffer_with_format(
            root.path().join("pixel.png"),
            &[0, 0, 0, 0],
            1,
            1,
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        )
        .unwrap();
        let result = read(FileReadRequest {
            root_path: root.path().display().to_string(),
            relative_path: "pixel.png".into(),
        })
        .unwrap();
        assert_eq!(result.kind, "image");
        assert!(result.content.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn read_rejects_video_before_reading_content() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("clip.mp4"), b"not-a-video").unwrap();
        assert_eq!(
            read(FileReadRequest {
                root_path: root.path().display().to_string(),
                relative_path: "clip.mp4".into(),
            })
            .unwrap_err(),
            "video_preview_unsupported"
        );
    }

    #[test]
    fn image_pixel_limit_allows_boundary_and_rejects_excess() {
        assert!(super::validate_image_pixel_count(4_000, 3_000).is_ok());
        assert_eq!(
            super::validate_image_pixel_count(4_000, 3_001).unwrap_err(),
            "image_dimensions_too_large"
        );
    }
}
