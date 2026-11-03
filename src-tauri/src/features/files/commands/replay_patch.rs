use super::{
    bounded_read::read_bounded, resolve_existing_path, validate_relative_path, TextFilePayload,
};
use crate::app_paths::cli_manager_data_dir;
use std::{fs::File, path::Path};

const REPLAY_PATCH_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[tauri::command]
// The larger allowance applies only to managed snapshots, never arbitrary project files.
pub async fn file_read_replay_patch(relative_path: String) -> Result<TextFilePayload, String> {
    tokio::task::spawn_blocking(move || read_replay_patch(&cli_manager_data_dir()?, &relative_path))
        .await
        .map_err(|err| err.to_string())?
}

fn read_replay_patch(data_dir: &Path, relative_path: &str) -> Result<TextFilePayload, String> {
    validate_relative_path(relative_path).map_err(|err| err.to_string())?;
    let relative = Path::new(&relative_path);
    let tail = relative
        .strip_prefix("replay-snapshots")
        .map_err(|_| "replay_patch_path_invalid".to_string())?;
    if relative.extension().and_then(|ext| ext.to_str()) != Some("patch") {
        return Err("replay_patch_path_invalid".into());
    }
    let data_root = data_dir.canonicalize().map_err(|err| err.to_string())?;
    let root = resolve_existing_path(&data_root, "replay-snapshots")?;
    let path = resolve_existing_path(&root, &tail.to_string_lossy())?;
    let file = File::open(path).map_err(|err| format!("read_file_failed: {err}"))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("metadata_failed: {err}"))?;
    if !metadata.is_file() {
        return Err("not_file".into());
    }
    if metadata.len() > REPLAY_PATCH_MAX_BYTES {
        return Err("file_too_large".into());
    }
    let bytes = read_bounded(file, REPLAY_PATCH_MAX_BYTES)?;
    let size_bytes = bytes.len() as u64;
    let content = String::from_utf8(bytes).map_err(|_| "not_utf8".to_string())?;
    Ok(TextFilePayload {
        content,
        size_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_patch_reader_accepts_two_mib_but_rejects_other_paths_and_oversize() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("replay-snapshots")).unwrap();
        let path = dir.path().join("replay-snapshots/synthetic.patch");
        std::fs::write(&path, vec![b'x'; 2 * 1024 * 1024]).unwrap();
        let text = read_replay_patch(dir.path(), "replay-snapshots/synthetic.patch").unwrap();
        assert_eq!(text.size_bytes, 2 * 1024 * 1024);
        assert_eq!(text.content.len(), 2 * 1024 * 1024);
        assert!(read_replay_patch(dir.path(), "outside.patch").is_err());
        assert!(read_replay_patch(dir.path(), "replay-snapshots/../outside.patch").is_err());
        assert!(read_replay_patch(dir.path(), "replay-snapshots/synthetic.txt").is_err());
        File::create(&path)
            .unwrap()
            .set_len(REPLAY_PATCH_MAX_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_replay_patch(dir.path(), "replay-snapshots/synthetic.patch")
                .err()
                .unwrap(),
            "file_too_large"
        );
    }
}
