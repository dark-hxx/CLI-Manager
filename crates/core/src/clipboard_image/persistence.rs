use super::MAX_BYTES;
use crate::data_paths::path_is_symlink_or_reparse;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub fn save_png(data_root: &Path, png: &[u8]) -> Result<PathBuf, String> {
    if png.is_empty() || png.len() > MAX_BYTES {
        return Err("clipboard_image_too_large".into());
    }
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("clipboard_image_unsupported".into());
    }
    ensure_plain_directory(data_root)?;
    let root = data_root
        .canonicalize()
        .map_err(|_| "path_canonicalize_failed")?;
    let directory = data_root.join("attachments");
    ensure_plain_directory(&directory)?;
    let canonical = directory
        .canonicalize()
        .map_err(|_| "path_canonicalize_failed")?;
    if canonical == root || !canonical.starts_with(&root) {
        return Err("path_outside_root".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(&directory).map_err(|_| "write_file_failed")?;
    temporary.write_all(png).map_err(|_| "write_file_failed")?;
    temporary.flush().map_err(|_| "write_file_failed")?;
    for index in 0..10_000 {
        let name = if index == 0 {
            "clipboard-image.png".to_owned()
        } else {
            format!("clipboard-image-{index}.png")
        };
        let target = directory.join(name);
        match temporary.persist_noclobber(&target) {
            Ok(_) => return Ok(target),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temporary = error.file;
            }
            Err(_) => return Err("write_file_failed".into()),
        }
    }
    Err("attachment_name_exhausted".into())
}

fn ensure_plain_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if path_is_symlink_or_reparse(path)? {
                return Err("path_is_symlink".into());
            }
            if !metadata.is_dir() {
                return Err("path_not_directory".into());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure_plain_directory(path)
            }
            Err(_) => Err("create_dir_failed".into()),
        },
        Err(_) => Err("metadata_failed".into()),
    }
}
