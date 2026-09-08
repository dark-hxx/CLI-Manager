use std::{
    fs,
    io::Cursor,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use image::ImageDecoder;
use memchr::memmem;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_paths::cli_manager_data_dir;
use crate::file_watcher::FileWatcherBridge;
use crate::shell_resolver::silent_command;
use crate::text_encoding::{decode_text, encode_text};

const TEXT_FILE_MAX_BYTES: u64 = 1024 * 1024;
const IMAGE_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;
const IMAGE_MAX_PIXELS: u64 = 12_000_000;
const FILE_SEARCH_MAX_RESULTS: usize = 1000;
const CONTENT_SEARCH_MAX_RESULTS: usize = 200;
const CONTENT_SEARCH_MAX_FILE_BYTES: u64 = 1024 * 1024;
const CONTENT_SEARCH_CONTEXT_LINES: usize = 1;
const CONTENT_SEARCH_MAX_LINE_CHARS: usize = 300;
const SEARCH_SKIPPED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".trellis",
    ".idea",
    ".vscode",
    ".cache",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
];
const CONTENT_SEARCH_SKIPPED_EXTENSIONS: &[&str] = &[
    "7z", "bmp", "class", "dll", "dmg", "exe", "gif", "gz", "ico", "jar", "jpeg", "jpg", "lockb",
    "mov", "mp3", "mp4", "pdf", "png", "pyc", "rar", "so", "tar", "wasm", "webp", "zip",
];
const ATTACHMENT_RETENTION_SECS: u64 = 2 * 24 * 60 * 60;
const CLIPBOARD_IMAGE_MAX_FILES: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_symlink: bool,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFilePayload {
    pub content: String,
    pub size_bytes: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextFilePayload {
    pub content: String,
    pub size_bytes: u64,
    pub encoding: String,
    pub has_bom: bool,
    pub guessed: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFilePayload {
    pub data_base64: String,
    pub mime_type: String,
    pub size_bytes: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatch {
    pub path: String,
    pub name: String,
    pub line_number: usize,
    pub line_text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImageAttachments {
    pub paths: Vec<String>,
    pub had_files: bool,
    pub rejected_count: usize,
    pub rejection_code: Option<String>,
}
/// 读取系统剪贴板中的 `CF_HDROP` 文件路径列表（Windows 资源管理器复制文件时写入的格式）。
/// WebView2 的 ClipboardEvent 拿不到该格式，需走原生 Win32 API。非 Windows 平台返回空列表。
#[tauri::command]
// 在线程池读取系统剪贴板中的文件路径列表。
pub async fn clipboard_read_file_paths() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(read_clipboard_file_paths)
        .await
        .map_err(|err| err.to_string())?
}
/// Convert image files currently present in the Windows clipboard to PNG attachments.
/// The command intentionally accepts no paths from the WebView: it reads CF_HDROP itself
/// so a compromised renderer cannot turn this into an arbitrary file reader.
#[tauri::command]
// 从原生剪贴板取得图片文件并转换为应用 PNG 附件，不接受前端文件路径。
pub async fn clipboard_attach_image_files() -> Result<ClipboardImageAttachments, String> {
    tokio::task::spawn_blocking(attach_clipboard_image_files)
        .await
        .map_err(|err| err.to_string())?
}
// 处理剪贴板中的前八个文件，收集生成附件及首个拒绝原因。
fn attach_clipboard_image_files() -> Result<ClipboardImageAttachments, String> {
    let file_paths = read_clipboard_file_paths()?;
    if file_paths.is_empty() {
        return Ok(ClipboardImageAttachments {
            paths: Vec::new(),
            had_files: false,
            rejected_count: 0,
            rejection_code: None,
        });
    }

    let data_dir = cli_manager_data_dir()?;
    let attachments_dir = ensure_attachment_dir(&data_dir)?;
    let mut paths = Vec::new();
    let mut rejected_count = 0;
    let mut rejection_code = None;
    for source in file_paths.into_iter().take(CLIPBOARD_IMAGE_MAX_FILES) {
        match convert_clipboard_image_file(Path::new(&source), &attachments_dir) {
            Ok(path) => paths.push(path.to_string_lossy().into_owned()),
            Err(code) => {
                rejected_count += 1;
                rejection_code.get_or_insert(code);
            }
        }
    }
    Ok(ClipboardImageAttachments {
        paths,
        had_files: true,
        rejected_count,
        rejection_code,
    })
}
// 拒绝链接和超限图片，应用方向信息并按需缩小后写入 PNG 附件。
fn convert_clipboard_image_file(source: &Path, attachments_dir: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(source).map_err(|_| "clipboard_image_unavailable")?;
    if is_symlink_or_reparse(&metadata) || !metadata.is_file() {
        return Err("clipboard_image_not_regular_file".into());
    }
    if metadata.len() == 0 || metadata.len() > IMAGE_FILE_MAX_BYTES {
        return Err("clipboard_image_too_large".into());
    }
    if !is_clipboard_image_extension(source) {
        return Err("unsupported_image".into());
    }

    let mut decoder = image::ImageReader::open(source)
        .map_err(|_| "unsupported_image")?
        .with_guessed_format()
        .map_err(|_| "unsupported_image")?
        .into_decoder()
        .map_err(|_| "unsupported_image")?;
    let (width, height) = decoder.dimensions();
    validate_image_pixel_count(width, height)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(|_| "unsupported_image")?;
    image.apply_orientation(orientation);

    let mut encoded = Vec::new();
    for _ in 0..5 {
        encoded.clear();
        image
            .write_to(&mut Cursor::new(&mut encoded), image::ImageFormat::Png)
            .map_err(|_| "image_encode_failed")?;
        if encoded.len() as u64 <= IMAGE_FILE_MAX_BYTES {
            break;
        }
        let (current_width, current_height) = image::GenericImageView::dimensions(&image);
        let scale = (IMAGE_FILE_MAX_BYTES as f64 / encoded.len() as f64).sqrt() * 0.9;
        let next_width = ((current_width as f64 * scale).round() as u32).max(1);
        let next_height = ((current_height as f64 * scale).round() as u32).max(1);
        if next_width >= current_width && next_height >= current_height {
            break;
        }
        image = image.resize(
            next_width,
            next_height,
            image::imageops::FilterType::Lanczos3,
        );
    }
    if encoded.len() as u64 > IMAGE_FILE_MAX_BYTES {
        return Err("clipboard_image_too_large".into());
    }

    let target = unique_attachment_target(attachments_dir, "clipboard-image.png")?;
    fs::write(&target, encoded).map_err(|_| "write_file_failed")?;
    Ok(target)
}
// 按扩展名判断是否属于可转换的常见剪贴板图片格式。
fn is_clipboard_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png"
                    | "apng"
                    | "jpg"
                    | "jpeg"
                    | "jfif"
                    | "gif"
                    | "webp"
                    | "bmp"
                    | "dib"
                    | "tif"
                    | "tiff"
                    | "ico"
            )
        })
        .unwrap_or(false)
}
#[cfg(target_os = "windows")]
// 读取 Windows CF_HDROP 文件列表，剪贴板暂不可用时返回空列表。
fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_HDROP: u32 = 15;

    // OpenClipboard 可能因其他进程短暂占用而失败，静默返回空列表而非报错。
    if unsafe { OpenClipboard(std::ptr::null_mut()) } == 0 {
        return Ok(Vec::new());
    }

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        // 退出作用域时关闭已打开的 Windows 剪贴板。
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    let _guard = ClipboardGuard;

    let handle = unsafe { GetClipboardData(CF_HDROP) };
    if handle.is_null() {
        return Ok(Vec::new());
    }

    // GlobalLock 后 HDROP 才可用；解锁与关闭剪贴板分别由手动调用和 guard 负责。
    let locked = unsafe { GlobalLock(handle as *mut _) };
    if locked.is_null() {
        return Ok(Vec::new());
    }
    let hdrop = locked as HDROP;

    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, std::ptr::null_mut(), 0) };
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        // 先查长度（不含结尾 NUL），再按长度 + 1 取内容。
        let len = unsafe { DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0) };
        if len == 0 {
            continue;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied =
            unsafe { DragQueryFileW(hdrop, index, buffer.as_mut_ptr(), buffer.len() as u32) };
        if copied == 0 {
            continue;
        }
        let path = std::ffi::OsString::from_wide(&buffer[..copied as usize]);
        paths.push(path.to_string_lossy().into_owned());
    }

    unsafe {
        GlobalUnlock(handle as *mut _);
    }
    Ok(paths)
}
#[cfg(not(target_os = "windows"))]
// 在非 Windows 平台返回空剪贴板文件列表。
fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
#[tauri::command]
// 在线程池按输入顺序批量检查本地或 WSL 路径是否存在。
pub async fn check_paths_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    tokio::task::spawn_blocking(move || paths.iter().map(|p| path_exists(p)).collect())
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
// 在线程池查询路径属于文件、目录还是缺失。
pub async fn file_get_path_kind(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || path_kind(&path))
        .await
        .map_err(|e| e.to_string())
}
// 按本地元数据或 WSL 检查结果返回路径类型。
fn path_kind(path: &str) -> String {
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(path) {
        return wsl_path_kind(&distro, &linux_path);
    }
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => "directory",
        Ok(metadata) if metadata.is_file() => "file",
        _ => "missing",
    }
    .into()
}
// 按本地或 WSL 路径路由存在性检查。
fn path_exists(path: &str) -> bool {
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(path) {
        return wsl_path_exists(&distro, &linux_path);
    }
    Path::new(path).exists()
}
// 启动 WSL shell 检查节点或符号链接是否存在，失败视为不存在。
fn wsl_path_exists(distro: &str, linux_path: &str) -> bool {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let args = wsl_path_exists_args(distro, linux_path);
    silent_command(&wsl_exe.to_string_lossy())
        .args(&args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
// 将 WSL 路径作为位置参数传入节点存在性检查脚本。
fn wsl_path_exists_args(distro: &str, linux_path: &str) -> Vec<String> {
    vec![
        "-d".into(),
        distro.into(),
        "--exec".into(),
        "sh".into(),
        "-c".into(),
        "test -e \"$1\" || test -L \"$1\"".into(),
        "cli-manager-path-check".into(),
        linux_path.into(),
    ]
}
// 启动 WSL shell 查询路径类型，失败或异常输出归为缺失。
fn wsl_path_kind(distro: &str, linux_path: &str) -> String {
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let output = silent_command(&wsl_exe.to_string_lossy())
        .args(wsl_path_kind_args(distro, linux_path))
        .output();
    let Ok(output) = output else {
        return "missing".into();
    };
    if !output.status.success() {
        return "missing".into();
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "directory" => "directory",
        "file" => "file",
        _ => "missing",
    }
    .into()
}
// 构造通过位置参数读取路径类型的 WSL shell 参数。
fn wsl_path_kind_args(distro: &str, linux_path: &str) -> Vec<String> {
    vec![
        "-d".into(),
        distro.into(),
        "--exec".into(),
        "sh".into(),
        "-c".into(),
        "if test -d \"$1\"; then printf directory; elif test -f \"$1\"; then printf file; else printf missing; fi".into(),
        "cli-manager-path-kind".into(),
        linux_path.into(),
    ]
}
#[tauri::command]
// 为指定项目启动文件变化监听。
pub async fn file_watch_start(
    app_handle: AppHandle,
    bridge: State<'_, FileWatcherBridge>,
    project_path: String,
) -> Result<(), String> {
    bridge.start(app_handle, project_path)
}
#[tauri::command]
// 停止指定项目的文件变化监听。
pub async fn file_watch_stop(
    bridge: State<'_, FileWatcherBridge>,
    project_path: String,
) -> Result<(), String> {
    bridge.stop(project_path)
}
#[tauri::command]
// 在线程池读取项目相对目录的条目列表。
pub async fn file_list_dir(
    root_path: String,
    relative_path: String,
) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || list_dir_entries(&root_path, &relative_path))
        .await
        .map_err(|err| err.to_string())?
}
// 按本地或 WSL 路径列目录，原生路径需规范化并限制在根内。
fn list_dir_entries(root_path: &str, relative_path: &str) -> Result<Vec<FileEntry>, String> {
    if let Some((distro, linux_root)) = crate::wsl::parse_wsl_unc_path(root_path) {
        return list_wsl_dir_entries(&distro, &linux_root, relative_path);
    }

    let root = canonical_root(root_path)?;
    let dir = resolve_existing_path(&root, relative_path)?;
    if !dir.is_dir() {
        return Err("not_directory".into());
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("read_dir_entry_failed: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("file_type_failed: {err}"))?;
        let metadata = entry
            .metadata()
            .map_err(|err| format!("metadata_failed: {err}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = relative_from_root(&root, &path)?;
        entries.push(FileEntry {
            name,
            path: rel,
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            }
            .into(),
            is_symlink: file_type.is_symlink(),
            size_bytes: metadata.len(),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64),
        });
    }

    sort_file_entries(&mut entries);
    Ok(entries)
}
// 校验相对路径后调用 WSL find，解析目录条目或返回命令错误。
fn list_wsl_dir_entries(
    distro: &str,
    linux_root: &str,
    relative_path: &str,
) -> Result<Vec<FileEntry>, String> {
    validate_relative_path(relative_path).map_err(|err| err.to_string())?;
    let linux_dir = join_linux_path(linux_root, relative_path);
    let wsl_exe = crate::wsl::find_wsl_exe().unwrap_or_else(|| PathBuf::from("wsl.exe"));
    let output = silent_command(&wsl_exe.to_string_lossy())
        .args(["-d", distro, "--exec"])
        .args(wsl_find_dir_args(&linux_dir))
        .output()
        .map_err(|err| format!("read_dir_failed: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("read_dir_failed: {}", stderr.trim()));
    }

    parse_wsl_find_dir_entries(&output.stdout, relative_path)
}
// 构造只读取一层目录且跟随命令行根链接的 find 参数。
fn wsl_find_dir_args(linux_dir: &str) -> [&str; 9] {
    [
        "find",
        "-H",
        linux_dir,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-printf",
        "%f\\0%y\\0%Y\\0%s\\0%T@\\0",
    ]
}
// 去除根路径末尾斜杠，再拼接相对 Linux 路径。
fn join_linux_path(root: &str, relative_path: &str) -> String {
    let root = root.trim_end_matches('/');
    if relative_path.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{}", relative_path.trim_start_matches('/'))
    }
}
// 解析 NUL 分隔的 find 元数据，区分链接目标类型并排序。
fn parse_wsl_find_dir_entries(
    stdout: &[u8],
    relative_path: &str,
) -> Result<Vec<FileEntry>, String> {
    let mut fields = stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut entries = Vec::new();

    loop {
        let Some(name_raw) = fields.next() else {
            break;
        };
        let kind_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;
        let target_kind_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;
        let size_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;
        let modified_raw = fields
            .next()
            .ok_or_else(|| "read_dir_parse_failed".to_string())?;

        let name = String::from_utf8_lossy(name_raw).to_string();
        let is_symlink = kind_raw == b"l";
        let kind = if kind_raw == b"d" || (kind_raw == b"l" && target_kind_raw == b"d") {
            "directory"
        } else {
            "file"
        }
        .to_string();
        let size_bytes = String::from_utf8_lossy(size_raw)
            .parse::<u64>()
            .map_err(|err| format!("read_dir_parse_failed: {err}"))?;
        let modified_ms = parse_find_modified_ms(modified_raw);
        let path = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };

        entries.push(FileEntry {
            name,
            path,
            kind,
            is_symlink,
            size_bytes,
            modified_ms,
        });
    }

    sort_file_entries(&mut entries);
    Ok(entries)
}
// 将 find 的有限非负秒数转换为毫秒时间戳。
fn parse_find_modified_ms(raw: &[u8]) -> Option<u64> {
    let value = String::from_utf8_lossy(raw).parse::<f64>().ok()?;
    if value.is_finite() && value >= 0.0 {
        Some((value * 1000.0) as u64)
    } else {
        None
    }
}
// 按目录优先、名称忽略大小写的顺序排序文件条目。
fn sort_file_entries(entries: &mut [FileEntry]) {
    entries.sort_by_cached_key(|entry| {
        (
            if entry.kind == "directory" { 0u8 } else { 1u8 },
            entry.name.to_lowercase(),
        )
    });
}
#[tauri::command]
// 规范化项目根后递归匹配文件名或相对路径，并按路径排序结果。
pub async fn file_search(root_path: String, query: String) -> Result<Vec<FileEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        collect_search_matches(&root, &root, &needle, &mut entries)?;
        entries.sort_by_cached_key(|entry| entry.path.to_lowercase());
        Ok(entries)
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 规范化项目根后递归搜索文本内容，并按路径和行号排序。
pub async fn file_search_content(
    root_path: String,
    query: String,
) -> Result<Vec<ContentSearchMatch>, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut matches = Vec::new();
        collect_content_matches(&root, &root, &needle, &mut matches)?;
        matches.sort_by_cached_key(|item| (item.path.to_lowercase(), item.line_number));
        Ok(matches)
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 读取受大小限制的文本字节，要求内容为有效 UTF-8。
pub async fn file_read_text(
    root_path: String,
    relative_path: String,
) -> Result<TextFilePayload, String> {
    tokio::task::spawn_blocking(move || {
        let (bytes, size_bytes) = read_text_file_bytes(&root_path, &relative_path)?;
        let content = String::from_utf8(bytes).map_err(|_| "not_utf8".to_string())?;
        Ok(TextFilePayload {
            content,
            size_bytes,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 读取项目文本并检测编码，返回内容、BOM 和编码推断信息。
pub async fn file_read_project_text(
    root_path: String,
    relative_path: String,
) -> Result<ProjectTextFilePayload, String> {
    tokio::task::spawn_blocking(move || {
        let (bytes, size_bytes) = read_text_file_bytes(&root_path, &relative_path)?;
        let decoded = decode_text(&bytes)?;
        Ok(ProjectTextFilePayload {
            content: decoded.content,
            size_bytes,
            encoding: decoded.encoding,
            has_bom: decoded.has_bom,
            guessed: decoded.guessed,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 校验根内图片文件的大小与尺寸后返回 Base64 和媒体类型。
pub async fn file_read_image(
    root_path: String,
    relative_path: String,
) -> Result<ImageFilePayload, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let path = resolve_existing_path(&root, &relative_path)?;
        let metadata = fs::metadata(&path).map_err(|err| format!("metadata_failed: {err}"))?;
        if !metadata.is_file() {
            return Err("not_file".into());
        }
        if metadata.len() > IMAGE_FILE_MAX_BYTES {
            return Err("image_file_too_large".into());
        }
        let mime_type = image_mime_type(&path).ok_or_else(|| "unsupported_image".to_string())?;
        validate_image_dimensions(&path)?;
        let bytes = fs::read(&path).map_err(|err| format!("read_file_failed: {err}"))?;
        Ok(ImageFilePayload {
            data_base64: general_purpose::STANDARD.encode(bytes),
            mime_type: mime_type.into(),
            size_bytes: metadata.len(),
        })
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 在线程池将 UTF-8 文本写入经路径安全校验的目标。
pub async fn file_write_text(
    root_path: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_text_file_bytes(&root_path, &relative_path, content.into_bytes())
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 按指定编码和 BOM 编码内容，成功后写入经校验的项目文件。
pub async fn file_write_project_text(
    root_path: String,
    relative_path: String,
    content: String,
    encoding: String,
    has_bom: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let bytes = encode_text(&content, &encoding, has_bom)?;
        write_text_file_bytes(&root_path, &relative_path, bytes)
    })
    .await
    .map_err(|err| err.to_string())?
}
// 校验根内普通文件、视频扩展名和 1 MiB 限制，再读取字节。
fn read_text_file_bytes(root_path: &str, relative_path: &str) -> Result<(Vec<u8>, u64), String> {
    let root = canonical_root(root_path)?;
    let path = resolve_existing_path(&root, relative_path)?;
    let metadata = fs::metadata(&path).map_err(|err| format!("metadata_failed: {err}"))?;
    if !metadata.is_file() {
        return Err("not_file".into());
    }
    if is_video_path(&path) {
        return Err("video_preview_unsupported".into());
    }
    if metadata.len() > TEXT_FILE_MAX_BYTES {
        return Err("file_too_large".into());
    }
    let bytes = fs::read(&path).map_err(|err| format!("read_file_failed: {err}"))?;
    Ok((bytes, metadata.len()))
}
// 解析目标并校验父目录和已有目标，随后写入文本字节。
fn write_text_file_bytes(
    root_path: &str,
    relative_path: &str,
    bytes: impl AsRef<[u8]>,
) -> Result<(), String> {
    let root = canonical_root(root_path)?;
    let path = resolve_target_path(&root, relative_path)?;
    if let Some(parent) = path.parent() {
        ensure_existing_child_within_root(&root, parent)?;
    }
    ensure_target_safe_for_write(&root, &path)?;
    fs::write(&path, bytes).map_err(|err| format!("write_file_failed: {err}"))
}
#[tauri::command]
// 解析合法子文件目标，按覆盖策略清理后创建空文件。
pub async fn file_create_file(
    root_path: String,
    parent_path: String,
    name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_named_target(&root, &parent_path, &name)?;
        prepare_target(&target, overwrite)?;
        fs::write(&target, "").map_err(|err| format!("create_file_failed: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 解析合法子目录目标，按覆盖策略清理后创建目录。
pub async fn file_create_dir(
    root_path: String,
    parent_path: String,
    name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_named_target(&root, &parent_path, &name)?;
        prepare_target(&target, overwrite)?;
        fs::create_dir(&target).map_err(|err| format!("create_dir_failed: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 解析根内源路径和新名称，再按覆盖策略移动到同一父目录。
pub async fn file_rename(
    root_path: String,
    relative_path: String,
    new_name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let source = resolve_existing_path(&root, &relative_path)?;
        let parent = source
            .parent()
            .ok_or_else(|| "missing_parent".to_string())?;
        let target = resolve_child_target(&root, parent, &new_name)?;
        move_path(&root, &source, &target, overwrite)
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 解析根内目标并拒绝删除根目录，随后删除文件或目录。
pub async fn file_delete(root_path: String, relative_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let target = resolve_existing_path(&root, &relative_path)?;
        if target == root {
            return Err("cannot_delete_root".into());
        }
        remove_path(&target)
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 校验源和目标，拒绝复制目录到自身内部，再按覆盖策略复制。
pub async fn file_copy(
    root_path: String,
    source_path: String,
    target_parent_path: String,
    name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let source = resolve_existing_path(&root, &source_path)?;
        let target = resolve_named_target(&root, &target_parent_path, &name)?;
        if source.is_dir() && target.starts_with(&source) {
            return Err("target_inside_source".into());
        }
        prepare_target(&target, overwrite)?;
        copy_path(&root, &source, &target)
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 解码并校验非空且不超过 5 MiB 的附件，清理名称后写入应用目录。
pub async fn file_attach_data(file_name: String, data_base64: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let data = general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|err| format!("decode_failed: {err}"))?;
        if data.is_empty() {
            return Err("attachment_empty".into());
        }
        if data.len() as u64 > IMAGE_FILE_MAX_BYTES {
            return Err("attachment_too_large".into());
        }

        let data_dir = cli_manager_data_dir()?;
        let attachments_dir = ensure_attachment_dir(&data_dir)?;
        let file_name = sanitize_attachment_file_name(&file_name);
        let target = unique_attachment_target(&attachments_dir, &file_name)?;
        fs::write(&target, data).map_err(|err| format!("write_file_failed: {err}"))?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 在线程池删除应用附件目录中超过两天保留期的普通文件。
pub async fn file_cleanup_expired_attachments() -> Result<u64, String> {
    tokio::task::spawn_blocking(move || {
        let data_dir = cli_manager_data_dir()?;
        cleanup_expired_attachments(&data_dir, Duration::from_secs(ATTACHMENT_RETENTION_SECS))
    })
    .await
    .map_err(|err| err.to_string())?
}
#[tauri::command]
// 解析根内源和命名目标，并按覆盖策略移动。
pub async fn file_move(
    root_path: String,
    source_path: String,
    target_parent_path: String,
    name: String,
    overwrite: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(&root_path)?;
        let source = resolve_existing_path(&root, &source_path)?;
        let target = resolve_named_target(&root, &target_parent_path, &name)?;
        move_path(&root, &source, &target, overwrite)
    })
    .await
    .map_err(|err| err.to_string())?
}
// 允许空根路径，否则按路径组件拒绝绝对路径、父级和反斜杠。
pub(crate) fn validate_relative_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() {
        return Ok(());
    }
    if path.contains('\\') {
        return Err("path_contains_backslash");
    }
    let rel = Path::new(path);
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => return Err("path_contains_current_segment"),
            Component::ParentDir => return Err("path_contains_parent_segment"),
            Component::RootDir | Component::Prefix(_) => return Err("path_is_absolute"),
        }
    }
    Ok(())
}

// 拒绝空名称、点目录和路径分隔符。
pub(crate) fn validate_child_name(name: &str) -> Result<(), &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("empty_name");
    }
    if trimmed == "." || trimmed == ".." {
        return Err("invalid_name");
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("name_contains_separator");
    }
    Ok(())
}

// 要求根路径绝对存在且为目录，并返回规范化路径。
fn canonical_root(root_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root_path);
    if !root.is_absolute() {
        return Err("root_not_absolute".into());
    }
    let canonical = root
        .canonicalize()
        .map_err(|err| format!("root_canonicalize_failed: {err}"))?;
    if !canonical.is_dir() {
        return Err("root_not_directory".into());
    }
    Ok(canonical)
}

// 校验相对路径并规范化现有目标，要求解析结果仍位于根内。
fn resolve_existing_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative_path).map_err(|err| err.to_string())?;
    let joined = root.join(relative_path);
    let canonical = joined
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    ensure_existing_child_within_root(root, &canonical)?;
    Ok(canonical)
}

// 校验非空目标相对路径，并要求其现有父目录位于根内。
fn resolve_target_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative_path).map_err(|err| err.to_string())?;
    if relative_path.is_empty() {
        return Err("empty_target_path".into());
    }
    let target = root.join(relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| "missing_parent".to_string())?;
    ensure_existing_child_within_root(root, parent)?;
    Ok(target)
}

// 解析根内父目录并验证其为目录，再解析合法子名称。
fn resolve_named_target(root: &Path, parent_path: &str, name: &str) -> Result<PathBuf, String> {
    let parent = resolve_existing_path(root, parent_path)?;
    if !parent.is_dir() {
        return Err("target_parent_not_directory".into());
    }
    resolve_child_target(root, &parent, name)
}

// 校验子名称与父目录归属，返回拼接后的目标路径。
fn resolve_child_target(root: &Path, parent: &Path, name: &str) -> Result<PathBuf, String> {
    validate_child_name(name).map_err(|err| err.to_string())?;
    ensure_existing_child_within_root(root, parent)?;
    Ok(parent.join(name.trim()))
}

// 规范化现有路径并验证其位于规范化根目录下。
fn ensure_existing_child_within_root(root: &Path, path: &Path) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    if canonical.starts_with(root) {
        Ok(())
    } else {
        Err("path_escapes_root".into())
    }
}

// 规范化路径并校验根归属，返回正斜杠形式的相对路径。
fn relative_from_root(root: &Path, path: &Path) -> Result<String, String> {
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    if !canonical.starts_with(root) {
        return Err("path_escapes_root".into());
    }
    canonical
        .strip_prefix(root)
        .map_err(|err| format!("strip_prefix_failed: {err}"))
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

// 检测目标是否已存在，未授权覆盖则拒绝，授权后先删除旧目标。
fn prepare_target(target: &Path, overwrite: bool) -> Result<(), String> {
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if !overwrite {
                return Err("target_exists".into());
            }
            remove_path_with_metadata(target, metadata)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("metadata_failed: {err}")),
    }
}

// 检查符号链接标记，并在 Windows 下额外识别重解析点。
fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

// 允许缺失写入目标，已有目标则拒绝链接并校验根归属。
fn ensure_target_safe_for_write(root: &Path, target: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("metadata_failed: {err}")),
    };
    if is_symlink_or_reparse(&metadata) {
        return Err("path_is_symlink".into());
    }
    ensure_existing_child_within_root(root, target)
}

// 递归删除普通目录，其余类型按文件删除以避免递归跟随链接。
fn remove_path_with_metadata(path: &Path, metadata: fs::Metadata) -> Result<(), String> {
    if metadata.is_dir() && !is_symlink_or_reparse(&metadata) {
        fs::remove_dir_all(path).map_err(|err| format!("remove_dir_failed: {err}"))
    } else {
        fs::remove_file(path).map_err(|err| format!("remove_file_failed: {err}"))
    }
}

// 读取不跟随链接的元数据后选择文件或目录删除方式。
fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|err| format!("metadata_failed: {err}"))?;
    remove_path_with_metadata(path, metadata)
}

// 要求路径为非链接目录，缺失时创建单层目录。
fn ensure_plain_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_symlink_or_reparse(&metadata) {
                return Err("path_is_symlink".into());
            }
            if metadata.is_dir() {
                Ok(())
            } else {
                Err("path_not_directory".into())
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|err| format!("create_dir_failed: {err}"))
        }
        Err(err) => Err(format!("metadata_failed: {err}")),
    }
}

// 确保应用数据和附件目录为普通目录，并验证附件目录归属。
fn ensure_attachment_dir(data_dir: &Path) -> Result<PathBuf, String> {
    ensure_plain_dir(data_dir)?;
    let canonical_data_dir = data_dir
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    let attachments_dir = data_dir.join("attachments");
    ensure_plain_dir(&attachments_dir)?;
    ensure_existing_child_within_root(&canonical_data_dir, &attachments_dir)?;
    Ok(attachments_dir)
}

// 只读取已有附件目录并校验链接和根归属，不存在则返回空值。
fn get_existing_attachment_dir(data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let attachments_dir = data_dir.join("attachments");
    match fs::symlink_metadata(&attachments_dir) {
        Ok(metadata) => {
            if is_symlink_or_reparse(&metadata) {
                return Err("path_is_symlink".into());
            }
            if !metadata.is_dir() {
                return Err("path_not_directory".into());
            }
            let canonical_data_dir = data_dir
                .canonicalize()
                .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
            ensure_existing_child_within_root(&canonical_data_dir, &attachments_dir)?;
            Ok(Some(attachments_dir))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("metadata_failed: {err}")),
    }
}

// 按修改时间删除过期普通附件文件，跳过链接、目录和无法读取时间的条目。
fn cleanup_expired_attachments(data_dir: &Path, max_age: Duration) -> Result<u64, String> {
    let Some(attachments_dir) = get_existing_attachment_dir(data_dir)? else {
        return Ok(0);
    };
    let now = SystemTime::now();
    let mut deleted = 0;
    for item in fs::read_dir(&attachments_dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("dir_entry_failed: {err}"))?;
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("metadata_failed: {err}")),
        };
        if is_symlink_or_reparse(&metadata) || !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() < max_age {
            continue;
        }
        fs::remove_file(&path).map_err(|err| format!("remove_file_failed: {err}"))?;
        deleted += 1;
    }
    Ok(deleted)
}

// 将附件名称中的空白、控制符和路径危险字符替换为下划线。
fn sanitize_attachment_file_name(name: &str) -> String {
    let sanitized = name
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_control()
                || ch.is_whitespace()
                || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .trim_matches('_')
        .to_string();

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "attachment".into()
    } else {
        sanitized
    }
}

// 逐次追加数字后缀寻找未占用的附件路径，最多尝试一万个名称。
fn unique_attachment_target(dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("attachment");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 0..10_000 {
        let candidate_name = if index == 0 {
            file_name.to_string()
        } else if let Some(extension) = extension {
            format!("{stem}-{index}.{extension}")
        } else {
            format!("{stem}-{index}")
        };
        let candidate = dir.join(candidate_name);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(err) => return Err(format!("metadata_failed: {err}")),
        }
    }

    Err("attachment_name_exhausted".into())
}

// 拒绝复制符号链接或重解析点，并确认源规范化后仍在根内。
fn ensure_copy_source_safe(root: &Path, source: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(source).map_err(|err| format!("metadata_failed: {err}"))?;
    if is_symlink_or_reparse(&metadata) {
        return Err("path_is_symlink".into());
    }
    let canonical = source
        .canonicalize()
        .map_err(|err| format!("path_canonicalize_failed: {err}"))?;
    if !canonical.starts_with(root) {
        return Err("path_escapes_root".into());
    }
    Ok(metadata)
}

// 校验复制源后按类型复制单文件或递归目录。
fn copy_path(root: &Path, source: &Path, target: &Path) -> Result<(), String> {
    let metadata = ensure_copy_source_safe(root, source)?;
    if metadata.is_dir() {
        copy_dir_recursive(root, source, target)
    } else {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|err| format!("copy_file_failed: {err}"))
    }
}

// 创建目标目录并逐项调用安全复制流程复制子条目。
fn copy_dir_recursive(root: &Path, source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target).map_err(|err| format!("copy_dir_create_failed: {err}"))?;
    for item in fs::read_dir(source).map_err(|err| format!("copy_dir_read_failed: {err}"))? {
        let entry = item.map_err(|err| format!("copy_dir_entry_failed: {err}"))?;
        let child_source = entry.path();
        let child_target = target.join(entry.file_name());
        copy_path(root, &child_source, &child_target)?;
    }
    Ok(())
}

// 拒绝移动根目录或移动目录到自身内部，按覆盖策略清理目标后重命名。
fn move_path(root: &Path, source: &Path, target: &Path, overwrite: bool) -> Result<(), String> {
    if source == root {
        return Err("cannot_move_root".into());
    }
    if source.is_dir() && target.starts_with(source) {
        return Err("target_inside_source".into());
    }
    prepare_target(target, overwrite)?;
    fs::rename(source, target).map_err(|err| format!("move_failed: {err}"))
}

// 按图片扩展名返回支持的媒体类型。
fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())?
        .as_str()
    {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

// 按扩展名识别不支持文本预览的视频文件。
fn is_video_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
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
                | "webm"
                | "wmv"
        )
    )
}

// SVG 跳过像素尺寸检查，其余图片读取尺寸后校验像素总数。
fn validate_image_dimensions(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        return Ok(());
    }
    let (width, height) =
        image::image_dimensions(path).map_err(|_| "unsupported_image".to_string())?;
    validate_image_pixel_count(width, height)
}

// 拒绝像素总数超过一千二百万的图片尺寸。
fn validate_image_pixel_count(width: u32, height: u32) -> Result<(), String> {
    if u64::from(width) * u64::from(height) > IMAGE_MAX_PIXELS {
        return Err("image_dimensions_too_large".into());
    }
    Ok(())
}

// 从扫描路径直接剥离根前缀并统一为正斜杠相对路径。
fn search_relative_from_root(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|err| format!("strip_prefix_failed: {err}"))
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

// 忽略大小写判断目录是否属于搜索排除名单。
fn should_skip_search_dir(name: &str) -> bool {
    SEARCH_SKIPPED_DIRECTORY_NAMES
        .iter()
        .any(|skipped| skipped.eq_ignore_ascii_case(name))
}

// 按扩展名判断文件是否应跳过内容搜索。
fn should_skip_content_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    CONTENT_SEARCH_SKIPPED_EXTENSIONS
        .iter()
        .any(|skipped| skipped.eq_ignore_ascii_case(ext))
}

// 匹配已归一化搜索词，ASCII 使用字节匹配，其他文本转小写比较。
fn text_matches(value: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.is_ascii() {
        return memmem::find(value.as_bytes(), needle.as_bytes()).is_some()
            || contains_ascii_case_insensitive(value.as_bytes(), needle.as_bytes());
    }
    value.to_lowercase().contains(needle)
}

// 用滑动字节窗口进行 ASCII 忽略大小写子串匹配。
fn contains_ascii_case_insensitive(haystack: &[u8], needle_lowercase: &[u8]) -> bool {
    if needle_lowercase.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle_lowercase.len())
        .any(|window| window.eq_ignore_ascii_case(needle_lowercase))
}

// 将搜索结果行截为最多 300 字符，超长时追加省略号。
fn truncate_search_line(line: &str) -> String {
    let mut chars = line.chars();
    let truncated: String = chars.by_ref().take(CONTENT_SEARCH_MAX_LINE_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

// 递归匹配名称或路径并跳过重目录，最多收集一千条文件条目。
fn collect_search_matches(
    root: &Path,
    dir: &Path,
    needle: &str,
    out: &mut Vec<FileEntry>,
) -> Result<(), String> {
    if out.len() >= FILE_SEARCH_MAX_RESULTS {
        return Ok(());
    }
    for item in fs::read_dir(dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("read_dir_entry_failed: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("file_type_failed: {err}"))?;
        let metadata = entry
            .metadata()
            .map_err(|err| format!("metadata_failed: {err}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() && should_skip_search_dir(&name) {
            continue;
        }
        let rel = search_relative_from_root(root, &path)?;
        if text_matches(&name, needle) || text_matches(&rel, needle) {
            out.push(FileEntry {
                name: name.clone(),
                path: rel,
                kind: if file_type.is_dir() {
                    "directory"
                } else {
                    "file"
                }
                .into(),
                is_symlink: file_type.is_symlink(),
                size_bytes: metadata.len(),
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64),
            });
            if out.len() >= FILE_SEARCH_MAX_RESULTS {
                return Ok(());
            }
        }
        if file_type.is_dir() {
            collect_search_matches(root, &path, needle, out)?;
        }
    }
    Ok(())
}

// 递归扫描非排除文本文件，跳过超限或解码失败文件并限制结果数。
fn collect_content_matches(
    root: &Path,
    dir: &Path,
    needle: &str,
    out: &mut Vec<ContentSearchMatch>,
) -> Result<(), String> {
    if out.len() >= CONTENT_SEARCH_MAX_RESULTS {
        return Ok(());
    }
    for item in fs::read_dir(dir).map_err(|err| format!("read_dir_failed: {err}"))? {
        let entry = item.map_err(|err| format!("read_dir_entry_failed: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("file_type_failed: {err}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if !should_skip_search_dir(&name) {
                collect_content_matches(root, &path, needle, out)?;
            }
            if out.len() >= CONTENT_SEARCH_MAX_RESULTS {
                return Ok(());
            }
            continue;
        }
        if !file_type.is_file() || should_skip_content_file(&path) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|err| format!("metadata_failed: {err}"))?;
        if metadata.len() > CONTENT_SEARCH_MAX_FILE_BYTES {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let Ok(decoded) = decode_text(&bytes) else {
            continue;
        };
        collect_content_matches_in_file(root, &path, &name, &decoded.content, needle, out)?;
        if out.len() >= CONTENT_SEARCH_MAX_RESULTS {
            return Ok(());
        }
    }
    Ok(())
}

// 提取单文件首个匹配行和前后各一行上下文，并限制行显示长度。
fn collect_content_matches_in_file(
    root: &Path,
    path: &Path,
    name: &str,
    content: &str,
    needle: &str,
    out: &mut Vec<ContentSearchMatch>,
) -> Result<(), String> {
    let lines: Vec<&str> = content.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if out.len() >= CONTENT_SEARCH_MAX_RESULTS {
            return Ok(());
        }
        if !text_matches(line, needle) {
            continue;
        }
        let before_start = index.saturating_sub(CONTENT_SEARCH_CONTEXT_LINES);
        let after_end = usize::min(lines.len(), index + CONTENT_SEARCH_CONTEXT_LINES + 1);
        out.push(ContentSearchMatch {
            path: search_relative_from_root(root, path)?,
            name: name.to_string(),
            line_number: index + 1,
            line_text: truncate_search_line(line),
            before: lines[before_start..index]
                .iter()
                .map(|line| truncate_search_line(line))
                .collect(),
            after: lines[index + 1..after_end]
                .iter()
                .map(|line| truncate_search_line(line))
                .collect(),
        });
        return Ok(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    // 验证附件目录直接创建在应用数据目录下而不重复嵌套。
    fn attachment_directory_is_directly_under_cli_manager_data_dir() {
        let tmp = TempDir::new().unwrap();
        let data_dir = tmp.path().join(".cli-manager");

        let attachments_dir = ensure_attachment_dir(&data_dir).unwrap();

        assert_eq!(attachments_dir, data_dir.join("attachments"));
        assert!(attachments_dir.is_dir());
        assert!(!data_dir.join(".cli-manager").exists());
    }

    #[test]
    // 验证视频不可文本预览且图片像素限制按边界生效。
    fn preview_limits_reject_video_and_oversized_image_dimensions() {
        assert!(validate_image_pixel_count(4_000, 3_000).is_ok());
        assert_eq!(
            validate_image_pixel_count(4_000, 3_001).unwrap_err(),
            "image_dimensions_too_large"
        );

        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("clip.mp4"), b"not-a-video").unwrap();
        assert_eq!(
            read_text_file_bytes(&root.to_string_lossy(), "clip.mp4").unwrap_err(),
            "video_preview_unsupported"
        );
        fs::write(root.join("main.ts"), b"export const preview = true;\n").unwrap();
        assert!(read_text_file_bytes(&root.to_string_lossy(), "main.ts").is_ok());
    }

    #[test]
    // 验证相对路径校验接受空根和普通嵌套路径。
    fn validate_relative_path_accepts_root_and_nested_paths() {
        assert!(validate_relative_path("").is_ok());
        assert!(validate_relative_path("src/main.ts").is_ok());
        assert!(validate_relative_path("src/components/App.tsx").is_ok());
    }

    #[test]
    // 验证相对路径校验拒绝父级、反斜杠及绝对路径。
    fn validate_relative_path_rejects_escape_and_absolute_paths() {
        assert_eq!(
            validate_relative_path("../secret").unwrap_err(),
            "path_contains_parent_segment"
        );
        assert_eq!(
            validate_relative_path("src\\main.ts").unwrap_err(),
            "path_contains_backslash"
        );
        assert_eq!(
            validate_relative_path("/etc/passwd").unwrap_err(),
            "path_is_absolute"
        );
    }

    #[test]
    // 验证子名称校验拒绝空值、分隔符和父目录名称。
    fn validate_child_name_rejects_separators_and_empty_names() {
        assert!(validate_child_name("main.ts").is_ok());
        assert_eq!(validate_child_name("").unwrap_err(), "empty_name");
        assert_eq!(
            validate_child_name("a/b").unwrap_err(),
            "name_contains_separator"
        );
        assert_eq!(
            validate_child_name("a\\b").unwrap_err(),
            "name_contains_separator"
        );
        assert_eq!(validate_child_name("..").unwrap_err(), "invalid_name");
    }

    #[test]
    // 验证剪贴板图片扩展名白名单及未支持格式。
    fn clipboard_image_extensions_cover_common_desktop_formats() {
        for extension in [
            "png", "apng", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "dib", "tif", "tiff", "ico",
        ] {
            assert!(is_clipboard_image_extension(Path::new(&format!(
                "image.{extension}"
            ))));
        }
        for extension in ["svg", "avif", "heic", "heif", "txt"] {
            assert!(!is_clipboard_image_extension(Path::new(&format!(
                "image.{extension}"
            ))));
        }
    }

    #[test]
    // 验证临时 BMP 文件被转换为保持尺寸的 PNG 附件。
    fn clipboard_image_file_is_normalized_to_png_attachment() {
        let tmp = TempDir::new().unwrap();
        let source = tmp.path().join("source.bmp");
        let attachments = tmp.path().join("attachments");
        fs::create_dir(&attachments).unwrap();
        image::RgbImage::from_pixel(3, 2, image::Rgb([12, 34, 56]))
            .save(&source)
            .unwrap();

        let target = convert_clipboard_image_file(&source, &attachments).unwrap();

        assert_eq!(
            target.extension().and_then(|value| value.to_str()),
            Some("png")
        );
        assert_eq!(image::image_dimensions(target).unwrap(), (3, 2));
    }

    #[test]
    // 验证 WSL find 输出解析链接类型、时间和目录优先排序。
    fn parse_wsl_find_dir_entries_returns_sorted_relative_entries() {
        let output = [
            b"z.txt\0".as_slice(),
            b"f\0",
            b"f\0",
            b"12\0",
            b"1720000000.125\0",
            b"linked\0",
            b"l\0",
            b"d\0",
            b"30\0",
            b"1720000002.5\0",
            b"src\0",
            b"d\0",
            b"d\0",
            b"4096\0",
            b"1720000001.5\0",
        ]
        .concat();

        let entries = parse_wsl_find_dir_entries(&output, "parent").unwrap();

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "linked");
        assert_eq!(entries[0].path, "parent/linked");
        assert_eq!(entries[0].kind, "directory");
        assert!(entries[0].is_symlink);
        assert_eq!(entries[0].size_bytes, 30);
        assert_eq!(entries[1].name, "src");
        assert_eq!(entries[1].path, "parent/src");
        assert_eq!(entries[1].kind, "directory");
        assert!(!entries[1].is_symlink);
        assert_eq!(entries[1].size_bytes, 4096);
        assert_eq!(entries[1].modified_ms, Some(1_720_000_001_500));
        assert_eq!(entries[2].name, "z.txt");
        assert_eq!(entries[2].path, "parent/z.txt");
        assert_eq!(entries[2].kind, "file");
        assert!(!entries[2].is_symlink);
    }

    #[test]
    // 验证 Linux 项目路径与相对路径正确拼接。
    fn join_linux_path_preserves_root_and_nested_paths() {
        assert_eq!(join_linux_path("/home/me/project", ""), "/home/me/project");
        assert_eq!(
            join_linux_path("/home/me/project/", "src/main.ts"),
            "/home/me/project/src/main.ts"
        );
    }

    #[test]
    // 验证 WSL find 使用 -H 跟随命令行指定的根链接。
    fn wsl_find_dir_args_follows_command_line_symlink_roots() {
        let args = wsl_find_dir_args("/data/acGo");
        assert_eq!(args[0], "find");
        assert_eq!(args[1], "-H");
        assert_eq!(args[2], "/data/acGo");
    }

    #[test]
    // 验证本地临时文件的存在与缺失检查。
    fn path_exists_checks_native_paths() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("exists.txt");
        fs::write(&file, "ok").unwrap();

        assert!(path_exists(&file.to_string_lossy()));
        assert!(!path_exists(
            &tmp.path().join("missing.txt").to_string_lossy()
        ));
    }

    #[test]
    // 验证本地临时文件、目录和缺失路径的类型区分。
    fn path_kind_distinguishes_native_files_and_directories() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("exists.txt");
        let directory = tmp.path().join("directory");
        fs::write(&file, "ok").unwrap();
        fs::create_dir(&directory).unwrap();

        assert_eq!(path_kind(&file.to_string_lossy()), "file");
        assert_eq!(path_kind(&directory.to_string_lossy()), "directory");
        assert_eq!(
            path_kind(&tmp.path().join("missing").to_string_lossy()),
            "missing"
        );
    }

    #[test]
    // 验证不完整 WSL UNC 路径不会作为可解析 WSL 项目路径处理。
    fn path_exists_rejects_invalid_wsl_unc_without_launching_wsl() {
        assert!(!path_exists(r"\\wsl.localhost\Ubuntu"));
    }

    #[test]
    // 验证 WSL 存在性脚本同时识别节点和符号链接。
    fn wsl_path_exists_args_accepts_symlink_nodes() {
        let args = wsl_path_exists_args("Ubuntu-22.04", "/data/acGo");
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu-22.04",
                "--exec",
                "sh",
                "-c",
                "test -e \"$1\" || test -L \"$1\"",
                "cli-manager-path-check",
                "/data/acGo",
            ]
        );
    }

    #[test]
    // 验证含空格的 WSL 路径通过位置参数传递而不插入脚本。
    fn wsl_path_kind_args_pass_path_as_positional_argument() {
        assert_eq!(
            wsl_path_kind_args("Ubuntu-22.04", "/data/project name"),
            vec![
                "-d",
                "Ubuntu-22.04",
                "--exec",
                "sh",
                "-c",
                "if test -d \"$1\"; then printf directory; elif test -f \"$1\"; then printf file; else printf missing; fi",
                "cli-manager-path-kind",
                "/data/project name",
            ]
        );
    }

    #[test]
    // 验证现有路径解析拒绝通过父级片段越出项目根。
    fn resolve_existing_path_rejects_paths_outside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "secret").unwrap();
        let root = root.canonicalize().unwrap();

        assert_eq!(
            resolve_existing_path(&root, "../outside").unwrap_err(),
            "path_contains_parent_segment"
        );
    }

    #[test]
    // 验证复制与移动文件在临时根目录内保留内容。
    fn copy_and_move_stay_inside_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a").join("one.txt"), "one").unwrap();
        let root = root.canonicalize().unwrap();

        let source = resolve_existing_path(&root, "a/one.txt").unwrap();
        let target = resolve_named_target(&root, "", "two.txt").unwrap();
        copy_path(&root, &source, &target).unwrap();
        assert_eq!(fs::read_to_string(root.join("two.txt")).unwrap(), "one");

        let moved = resolve_named_target(&root, "", "three.txt").unwrap();
        move_path(&root, &target, &moved, false).unwrap();
        assert!(!root.join("two.txt").exists());
        assert_eq!(fs::read_to_string(root.join("three.txt")).unwrap(), "one");
    }

    #[test]
    // 验证写入目标检查拒绝指向已有文件的符号链接。
    fn file_write_rejects_symlink_targets() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("real.txt"), "real").unwrap();
        let root = root.canonicalize().unwrap();
        let link = root.join("link.txt");

        #[cfg(unix)]
        if std::os::unix::fs::symlink(root.join("real.txt"), &link).is_err() {
            return;
        }
        #[cfg(target_os = "windows")]
        if std::os::windows::fs::symlink_file(root.join("real.txt"), &link).is_err() {
            return;
        }

        assert_eq!(
            ensure_target_safe_for_write(&root, &link).unwrap_err(),
            "path_is_symlink"
        );
    }

    #[test]
    // 验证递归复制拒绝源目录中的符号链接。
    fn copy_rejects_nested_symlink_sources() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("real.txt"), "real").unwrap();
        let root = root.canonicalize().unwrap();
        let link = root.join("src").join("link.txt");

        #[cfg(unix)]
        if std::os::unix::fs::symlink(root.join("real.txt"), &link).is_err() {
            return;
        }
        #[cfg(target_os = "windows")]
        if std::os::windows::fs::symlink_file(root.join("real.txt"), &link).is_err() {
            return;
        }

        let err = copy_path(&root, &root.join("src"), &root.join("dst")).unwrap_err();
        assert_eq!(err, "path_is_symlink");
    }

    #[test]
    // 验证文件名搜索跳过 .git 等重目录。
    fn file_search_skips_heavy_directories() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src").join("needle.ts"), "ok").unwrap();
        fs::write(root.join(".git").join("needle.txt"), "skip").unwrap();
        let root = root.canonicalize().unwrap();

        let mut entries = Vec::new();
        collect_search_matches(&root, &root, "needle", &mut entries).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "src/needle.ts");
    }

    #[test]
    // 验证内容搜索返回匹配上下文并跳过依赖目录。
    fn content_search_returns_context_and_skips_heavy_directories() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(
            root.join("src").join("main.ts"),
            "first line\nconst target = true;\nthird line\nsecond target\n",
        )
        .unwrap();
        fs::write(root.join("node_modules").join("ignored.ts"), "target").unwrap();
        let root = root.canonicalize().unwrap();

        let mut matches = Vec::new();
        collect_content_matches(&root, &root, "target", &mut matches).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/main.ts");
        assert_eq!(matches[0].line_number, 2);
        assert_eq!(matches[0].line_text, "const target = true;");
        assert_eq!(matches[0].before, vec!["first line"]);
        assert_eq!(matches[0].after, vec!["third line"]);
    }

    #[test]
    // 验证内容搜索对每个文件只返回首个匹配行。
    fn content_search_returns_one_match_per_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("main.ts"), "target one\ntarget two\n").unwrap();
        fs::write(root.join("src").join("other.ts"), "target three\n").unwrap();
        let root = root.canonicalize().unwrap();

        let mut matches = Vec::new();
        collect_content_matches(&root, &root, "target", &mut matches).unwrap();

        assert_eq!(matches.len(), 2);
        assert!(matches
            .iter()
            .any(|item| item.path == "src/main.ts" && item.line_number == 1));
        assert!(matches
            .iter()
            .any(|item| item.path == "src/other.ts" && item.line_number == 1));
    }

    #[test]
    // 验证内容搜索能够解码并匹配 GBK 项目文本。
    fn content_search_decodes_gbk_project_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        let (bytes, _, had_errors) = encoding_rs::GBK.encode("第一行\n中文目标内容\n第三行\n");
        assert!(!had_errors);
        fs::write(root.join("legacy.cs"), bytes.as_ref()).unwrap();
        let root = root.canonicalize().unwrap();

        let mut matches = Vec::new();
        collect_content_matches(&root, &root, "目标", &mut matches).unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "legacy.cs");
        assert_eq!(matches[0].line_number, 2);
        assert_eq!(matches[0].line_text, "中文目标内容");
    }

    #[tokio::test]
    // 验证项目文本读写保持 GBK，无法编码的内容不会覆盖原文件。
    async fn project_text_commands_preserve_gbk_and_reject_unmappable_content() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("legacy.cs");
        let original = "你好，世界。\n";
        let (original_bytes, _, had_errors) = encoding_rs::GBK.encode(original);
        assert!(!had_errors);
        fs::write(&file, original_bytes.as_ref()).unwrap();

        let root_path = root.to_string_lossy().to_string();
        assert_eq!(
            file_read_text(root_path.clone(), "legacy.cs".to_string())
                .await
                .unwrap_err(),
            "not_utf8"
        );
        let payload = file_read_project_text(root_path.clone(), "legacy.cs".to_string())
            .await
            .unwrap();
        assert_eq!(payload.content, original);
        assert_eq!(payload.encoding, "gbk");
        assert!(!payload.has_bom);

        let updated = "你好，新的世界。\n";
        file_write_project_text(
            root_path.clone(),
            "legacy.cs".to_string(),
            updated.to_string(),
            payload.encoding.clone(),
            payload.has_bom,
        )
        .await
        .unwrap();
        let (expected_bytes, _, expected_errors) = encoding_rs::GBK.encode(updated);
        assert!(!expected_errors);
        assert_eq!(fs::read(&file).unwrap(), expected_bytes.as_ref());

        let before_failed_save = fs::read(&file).unwrap();
        let error = file_write_project_text(
            root_path,
            "legacy.cs".to_string(),
            "你好🙂".to_string(),
            payload.encoding,
            payload.has_bom,
        )
        .await
        .unwrap_err();
        assert_eq!(error, "text_encoding_unmappable");
        assert_eq!(fs::read(&file).unwrap(), before_failed_save);
    }
}
