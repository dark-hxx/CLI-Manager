use super::{
    codex_project_key_from_session, normalize_history_path, path_within_history_scope,
    remember_wsl_session_fingerprint, scan_session_computation, session_file_fingerprint,
    session_matches_project_path, summary_from_computation, wsl_find_session_files,
    HistorySessionSummary, SessionFileRef,
};
use std::path::{Path, PathBuf};
use uuid::Uuid;

// 只接管 Codex 单条精确 UUID 查询；文本搜索、分页和其他来源仍使用 catalog。
pub(super) fn bound_codex_query(
    source: Option<&str>,
    query: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Option<String> {
    if !source.is_some_and(|value| value.trim().eq_ignore_ascii_case("codex"))
        || limit != Some(1)
        || offset.unwrap_or(0) != 0
    {
        return None;
    }
    let session_id = query?.trim();
    Uuid::parse_str(session_id).ok()?;
    Some(session_id.to_string())
}

// 不读取其他 transcript 的内容，也不等待 catalog 锁；WSL 使用既有 guest find 边界。
fn rollout_candidates(root: &Path, session_id: &str) -> Vec<PathBuf> {
    let suffix = format!("-{session_id}.jsonl");
    let root_text = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_text) {
        let Some((distro, linux_root)) = crate::wsl::parse_wsl_unc_path(&root_text) else {
            return Vec::new();
        };
        return wsl_find_session_files(
            &linux_root,
            &distro,
            &format!("rollout-*{suffix}"),
            &|_| String::new(),
        )
        .into_iter()
        .map(|hit| {
            let unc = crate::wsl::linux_to_unc_wsl_path(&hit.linux_path, &distro);
            remember_wsl_session_fingerprint(&unc, hit.fingerprint);
            PathBuf::from(unc)
        })
        .collect();
    }

    let mut dirs = vec![root.to_path_buf()];
    let mut files = Vec::new();
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // 不跟随链接，避免目录循环或读取来源根之外的会话。
            if kind.is_dir() {
                dirs.push(entry.path());
            } else if kind.is_file() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("rollout-") && name.ends_with(&suffix) {
                    files.push(entry.path());
                }
            }
        }
    }
    files
}

// 文件名仅用于缩小范围，最终必须校验元数据身份及项目；缺失/歧义不借用邻居会话。
pub(super) fn find_bound_codex_session(
    root: &Path,
    session_id: &str,
    project_path: Option<&str>,
) -> Option<HistorySessionSummary> {
    Uuid::parse_str(session_id).ok()?;
    let target = project_path
        .map(normalize_history_path)
        .filter(|value| !value.is_empty());
    let mut result = None;
    for path in rollout_candidates(root, session_id) {
        if !path_within_history_scope(&path, root) {
            continue;
        }
        let file_ref = SessionFileRef {
            source: "codex".into(),
            project_key: codex_project_key_from_session(&path, root),
            path,
        };
        if target
            .as_deref()
            .is_some_and(|value| !session_matches_project_path(&file_ref, value))
        {
            continue;
        }
        let fingerprint = session_file_fingerprint(&file_ref.path);
        let computed = scan_session_computation(
            &file_ref.path,
            fingerprint.created_at,
            fingerprint.updated_at,
        );
        if computed.session_id != session_id {
            continue;
        }
        if result.is_some() {
            return None;
        }
        let mut summary = summary_from_computation(&file_ref, &computed);
        summary.updated_at = fingerprint.updated_at;
        result = Some(summary);
    }
    result
}

#[cfg(test)]
mod tests;
