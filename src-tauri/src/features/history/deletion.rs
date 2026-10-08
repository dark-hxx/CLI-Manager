use super::super::history_backup::{
    create_file_backup_snapshot, default_backup_root, lock_source_mutations,
};
use super::scope::is_supported_session_file;
use super::{is_subagent_transcript_path, SessionFileRef};
use std::fs;
use std::path::{Path, PathBuf};

// 这些读取器的删除单位是单份转录，不能据父目录推断子会话归属。
pub(super) fn is_single_file_delete_source(source: &str) -> bool {
    matches!(
        source,
        "pi" | "gemini" | "copilot" | "antigravity" | "kiro" | "cursor" | "cline"
    )
}

// 已通过来源/路径校验的转录使用默认备份根；不扩大到相邻文件或目录。
pub(super) fn delete_session_file(file_ref: &SessionFileRef) -> Result<usize, String> {
    delete_session_file_with_backup_root(file_ref, &default_backup_root()?)
}

// 文件级来源只允许删除一个普通转录文件，保留既有子代理直接变更限制。
pub(super) fn delete_session_file_with_backup_root(
    file_ref: &SessionFileRef,
    backups_dir: &Path,
) -> Result<usize, String> {
    if !is_single_file_delete_source(&file_ref.source) {
        return Err("unsupported_history_mutation_source".to_string());
    }
    if is_subagent_transcript_path(&file_ref.path) {
        return Err("history_subagent_mutation_not_allowed".to_string());
    }
    if !is_supported_session_file(&file_ref.path) || !file_ref.path.is_file() {
        return Err("invalid_session_file".to_string());
    }
    delete_session_files_with_backup_root(file_ref, vec![file_ref.path.clone()], backups_dir)
}

// 先备份完整的显式目标集，再顺序删除；失败时恢复本批已删除的文件。
pub(super) fn delete_session_files_with_backup_root(
    file_ref: &SessionFileRef,
    paths: Vec<PathBuf>,
    backups_dir: &Path,
) -> Result<usize, String> {
    let mut backups = Vec::with_capacity(paths.len());
    for path in &paths {
        if path.exists() {
            let source_session_id = path
                .file_stem()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "session".to_string());
            let backup = create_file_backup_snapshot(
                path,
                backups_dir,
                &file_ref.source,
                &source_session_id,
                "sessionDelete",
            )?;
            backups.push((path.clone(), backup));
        }
    }

    let mut deleted = 0usize;
    let mut deleted_paths = Vec::new();
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {
                deleted = deleted.saturating_add(1);
                deleted_paths.push(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                for deleted_path in deleted_paths.iter().rev() {
                    if let Some((_, backup)) = backups
                        .iter()
                        .find(|(original, _)| original == deleted_path)
                    {
                        if let Err(restore_err) = fs::copy(backup, deleted_path) {
                            let _ = lock_source_mutations(&file_ref.source);
                            return Err(format!(
                                "manualRecoveryRequired: delete={}; restore={}",
                                err, restore_err
                            ));
                        }
                    }
                }
                return Err(format!("failedRolledBack: {err}"));
            }
        }
    }
    Ok(deleted)
}
