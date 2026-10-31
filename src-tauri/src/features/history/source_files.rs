use super::super::history_backup::{
    create_file_backup_snapshot, default_backup_root,
    lock_source_mutations,
};
use super::{
    antigravity_path_parts, cline_project_key_from_path, codex_project_key_from_session,
    collect_files_recursive, collect_wsl_claude_session_files, collect_wsl_codex_session_files,
    copilot_project_key_from_path, cursor_project_key_from_path, gemini_project_key_from_path,
    grok_project_key_from_path, is_json, is_jsonl, kiro_project_key_from_path,
    load_antigravity_workspace_map, looks_like_antigravity_transcript_file,
    looks_like_cline_session_file, looks_like_copilot_events_file,
    looks_like_cursor_agent_transcript_file, looks_like_gemini_session_file,
    looks_like_grok_updates_file, looks_like_kiro_session_file, looks_like_pi_session_file,
    normalize_history_path, path_within_history_scope, pi_project_key_from_path,
    project_key_from_cwd, read_dir_entries, remember_wsl_session_fingerprint,
    scan_session_computation, session_file_fingerprint, session_matches_project_path,
    summary_from_computation, wsl_command_text, wsl_find_session_files, HistorySessionSummary,
    SessionFileRef,
};
use log::{debug, warn};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use uuid::Uuid;

// 收集 Claude JSONL 并附项目目录键，可解析 WSL 根目录时改用 WSL 扫描。
pub(super) fn collect_claude_session_files(root: &Path) -> Vec<SessionFileRef> {
    let root_str = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        debug!("[wsl] 检测到 WSL UNC 路径, 切换 wsl.exe 扫描: root={root_str}");
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&root_str) {
            debug!("[wsl] 解析成功: distro={distro} linux_path={linux_path}");
            return collect_wsl_claude_session_files(&linux_path, &distro);
        }
        warn!("[wsl] 路径检测为 WSL 但解析失败: {root_str}, 回退到原生 fs API");
    }

    if !root.exists() {
        return Vec::new();
    }

    let mut results = Vec::new();
    for entry in read_dir_entries(&root) {
        let path = entry.path();
        if path.is_dir() {
            let project_key = entry.file_name().to_string_lossy().to_string();
            let mut files = Vec::new();
            collect_files_recursive(&path, &mut files, &|file_path| is_jsonl(file_path));
            for file_path in files {
                results.push(SessionFileRef {
                    source: "claude".to_string(),
                    project_key: project_key.clone(),
                    path: file_path,
                });
            }
        } else if is_jsonl(&path) {
            results.push(SessionFileRef {
                source: "claude".to_string(),
                project_key: "default".to_string(),
                path,
            });
        }
    }

    results
}

// 收集 Codex rollout JSONL，本地解析项目 cwd，WSL 使用专用目录扫描。
pub(super) fn collect_codex_session_files(root: &Path) -> Vec<SessionFileRef> {
    let root_str = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        debug!("[wsl] 检测到 WSL UNC 路径, 切换 wsl.exe 扫描: root={root_str}");
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&root_str) {
            debug!("[wsl] 解析成功: distro={distro} linux_path={linux_path}");
            return collect_wsl_codex_session_files(&linux_path, &distro);
        }
        warn!("[wsl] 路径检测为 WSL 但解析失败: {root_str}, 回退到原生 fs API");
    }

    if !root.exists() {
        return Vec::new();
    }

    let mut files = Vec::new();
    collect_files_recursive(&root, &mut files, &|file_path| {
        if !is_jsonl(file_path) {
            return false;
        }
        let name = file_path
            .file_name()
            .map(|v| v.to_string_lossy().to_string())
            .unwrap_or_default();
        name.starts_with("rollout-")
    });

    files
        .into_iter()
        .map(|path| {
            let project_key = codex_project_key_from_session(&path, root);
            SessionFileRef {
                source: "codex".to_string(),
                project_key,
                path,
            }
        })
        .collect()
}

// 递归收集符合 Gemini 会话结构及名称的 JSON 文件并附项目键。
pub(super) fn collect_gemini_session_files(root: &Path) -> Vec<SessionFileRef> {
    if !root.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_files_recursive(root, &mut files, &|file_path| {
        is_json(file_path)
            && file_path.file_name().is_some_and(|name| {
                let name = name.to_string_lossy();
                name.starts_with("session-") && name.ends_with(".json")
            })
            && looks_like_gemini_session_file(file_path)
    });
    files
        .into_iter()
        .map(|path| SessionFileRef {
            source: "gemini".to_string(),
            project_key: gemini_project_key_from_path(&path, root),
            path,
        })
        .collect()
}

// 递归收集 Copilot events 文件并解析对应项目键。
pub(super) fn collect_copilot_session_files(root: &Path) -> Vec<SessionFileRef> {
    if !root.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_files_recursive(root, &mut files, &looks_like_copilot_events_file);
    files
        .into_iter()
        .map(|path| SessionFileRef {
            source: "copilot".to_string(),
            project_key: copilot_project_key_from_path(&path),
            path,
        })
        .collect()
}

// 扫描 brain 下的 Antigravity transcript，并由工作区映射补项目键。
pub(super) fn collect_antigravity_session_files(root: &Path) -> Vec<SessionFileRef> {
    let brain = root.join("brain");
    if !brain.exists() {
        return Vec::new();
    }
    let workspace_by_id = load_antigravity_workspace_map(root);
    let mut files = Vec::new();
    collect_files_recursive(&brain, &mut files, &looks_like_antigravity_transcript_file);
    files
        .into_iter()
        .filter_map(|path| {
            let (_, conversation_id) = antigravity_path_parts(&path)?;
            let project_key = workspace_by_id
                .get(&conversation_id)
                .and_then(|workspace| project_key_from_cwd(workspace))
                .unwrap_or_else(|| conversation_id.clone());
            Some(SessionFileRef {
                source: "antigravity".to_string(),
                project_key,
                path,
            })
        })
        .collect()
}

// 收集 Grok updates 文件，WSL 路径解析失败时不回退宿主递归。
pub(super) fn collect_grok_session_files(root: &Path) -> Vec<SessionFileRef> {
    let root_str = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&root_str) {
            return collect_wsl_grok_session_files(&linux_path, &distro);
        }
        warn!("[wsl] 路径检测为 WSL 但解析失败: {root_str}，不回退宿主递归");
        return Vec::new();
    }
    if !root.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_files_recursive(root, &mut files, &looks_like_grok_updates_file);
    files
        .into_iter()
        .map(|path| SessionFileRef {
            source: "grok".to_string(),
            project_key: grok_project_key_from_path(&path),
            path,
        })
        .collect()
}

// 通过 WSL find 收集 Grok updates 文件，转换为 UNC 引用并缓存指纹。
pub(super) fn collect_wsl_grok_session_files(
    linux_root: &str,
    distro: &str,
) -> Vec<SessionFileRef> {
    wsl_find_session_files(linux_root, distro, "updates.jsonl", &|linux_path| {
        grok_project_key_from_linux_path(linux_path)
    })
    .into_iter()
    .filter(|hit| looks_like_grok_linux_updates(&hit.linux_path))
    .map(|hit| {
        let unc = crate::wsl::linux_to_unc_wsl_path(&hit.linux_path, distro);
        remember_wsl_session_fingerprint(&unc, hit.fingerprint);
        let path = PathBuf::from(unc);
        SessionFileRef {
            source: "grok".to_string(),
            project_key: grok_project_key_from_path(&path),
            path,
        }
    })
    .collect()
}

// 按文件名及父级组件检查 Linux Grok updates 路径形状。
pub(super) fn looks_like_grok_linux_updates(linux_path: &str) -> bool {
    let normalized = linux_path.trim_end_matches('/');
    let Some((parent, name)) = normalized.rsplit_once('/') else {
        return false;
    };
    if !name.eq_ignore_ascii_case("updates.jsonl") {
        return false;
    }
    parent
        .rsplit_once('/')
        .is_some_and(|(workspace, session_id)| !workspace.is_empty() && !session_id.is_empty())
}

// 以 updates 文件父目录的会话名作为 Linux Grok 路径回退键。
pub(super) fn grok_project_key_from_linux_path(linux_path: &str) -> String {
    linux_path
        .trim_end_matches('/')
        .rsplit_once('/')
        .and_then(|(parent, _)| parent.rsplit_once('/'))
        .map(|(_, session_id)| session_id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "grok".to_string())
}

// 通过 WSL find 按会话目录模式定位首个符合形状的 updates 路径。
pub(super) fn wsl_find_exact_grok_updates(
    linux_root: &str,
    distro: &str,
    session_id: &str,
) -> Option<PathBuf> {
    let wsl_exe = crate::wsl::find_wsl_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "wsl.exe".to_string());
    let path_pattern = format!("*/{session_id}/updates.jsonl");
    let args = [
        "-d",
        distro,
        "--exec",
        "find",
        linux_root,
        "-path",
        path_pattern.as_str(),
        "-type",
        "f",
    ];
    let (stdout, _) = wsl_command_text(&wsl_exe, &args).ok()?;
    stdout
        .lines()
        .map(str::trim)
        .find(|line| looks_like_grok_linux_updates(line))
        .map(|linux_path| PathBuf::from(crate::wsl::linux_to_unc_wsl_path(linux_path, distro)))
}

// 对符合 Grok updates 识别条件的路径返回父会话目录。
pub(super) fn grok_session_dir_from_updates(path: &Path) -> Option<PathBuf> {
    looks_like_grok_updates_file(path).then(|| path.parent().map(Path::to_path_buf))?
}

// 校验修剪后的 Grok 会话 ID 长度及字母数字、下划线和连字符字符集。
pub(super) fn is_valid_grok_session_id(session_id: &str) -> bool {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > 128 {
        return false;
    }
    if session_id.contains(['/', '\\', '\0']) || session_id.contains("..") {
        return false;
    }
    session_id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

// 解析默认备份根目录后委托 Grok 会话目录备份删除流程。
pub(super) fn delete_grok_session_tree(
    file_ref: &SessionFileRef,
    home: &Path,
) -> Result<(), String> {
    let backups_dir = default_backup_root()?;
    delete_grok_session_tree_with_backup_root(file_ref, home, &backups_dir)
}

// 验证 Grok 会话范围并备份已知文件后删除目录，失败尝试恢复并必要时锁定来源。
pub(super) fn delete_grok_session_tree_with_backup_root(
    file_ref: &SessionFileRef,
    home: &Path,
    backups_dir: &Path,
) -> Result<(), String> {
    let Some(session_dir) = grok_session_dir_from_updates(&file_ref.path) else {
        return Err("invalid_session_file".to_string());
    };
    let canonical_home = home
        .canonicalize()
        .map_err(|_| "history_source_not_found".to_string())?;
    let canonical_session = session_dir
        .canonicalize()
        .map_err(|_| format!("Session directory not found: {}", session_dir.display()))?;
    if canonical_session == canonical_home
        || canonical_session.parent() == Some(canonical_home.as_path())
        || !path_within_history_scope(&canonical_session, &canonical_home)
    {
        return Err("session_file_outside_history_scope".to_string());
    }
    let session_id = canonical_session
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|id| is_valid_grok_session_id(id))
        .ok_or_else(|| "invalid_session_file".to_string())?;

    let updates = canonical_session.join("updates.jsonl");
    let summary = canonical_session.join("summary.json");
    let signals = canonical_session.join("signals.json");
    let mut backups = Vec::new();
    for path in [&updates, &summary, &signals] {
        if path.exists() {
            backups.push((
                path.clone(),
                create_file_backup_snapshot(
                    path,
                    backups_dir,
                    "grok",
                    &session_id,
                    "sessionDelete",
                )?,
            ));
        }
    }

    match fs::remove_dir_all(&canonical_session) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => {
            for (path, backup) in backups.iter().rev() {
                if let Err(restore_err) = fs::copy(backup, path) {
                    let _ = lock_source_mutations("grok");
                    return Err(format!(
                        "manualRecoveryRequired: delete={err}; restore={restore_err}"
                    ));
                }
            }
            Err(format!("failedRolledBack: {err}"))
        }
    }
}

// 验证 UUID 后定向定位 Grok 会话，匹配项目范围与解析身份后返回摘要。
pub(super) fn find_exact_grok_session_in_root(
    root: &Path,
    session_id: &str,
    project_path: Option<&str>,
) -> Option<HistorySessionSummary> {
    let session_id = session_id.trim();
    if Uuid::parse_str(session_id).is_err() {
        return None;
    }
    let target_project_path = project_path
        .map(normalize_history_path)
        .filter(|value| !value.is_empty());
    let root_str = root.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&root_str) else {
            warn!("[wsl] 路径检测为 WSL 但解析失败: {root_str}，跳过 Grok 精确直查");
            return None;
        };
        let path = wsl_find_exact_grok_updates(&linux_path, &distro, session_id)?;
        let file_ref = SessionFileRef {
            source: "grok".to_string(),
            project_key: grok_project_key_from_path(&path),
            path: path.clone(),
        };
        if target_project_path
            .as_deref()
            .is_some_and(|target| !session_matches_project_path(&file_ref, target))
        {
            return None;
        }
        let fingerprint = session_file_fingerprint(&file_ref.path);
        let computed = scan_session_computation(
            &file_ref.path,
            fingerprint.created_at,
            fingerprint.updated_at,
        );
        if computed.session_id != session_id {
            return None;
        }
        return Some(summary_from_computation(&file_ref, &computed));
    }
    for workspace in read_dir_entries(root) {
        let path = workspace.path().join(session_id).join("updates.jsonl");
        if !looks_like_grok_updates_file(&path) {
            continue;
        }
        let file_ref = SessionFileRef {
            source: "grok".to_string(),
            project_key: grok_project_key_from_path(&path),
            path,
        };
        if target_project_path
            .as_deref()
            .is_some_and(|target| !session_matches_project_path(&file_ref, target))
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
        return Some(summary_from_computation(&file_ref, &computed));
    }
    None
}

// 扫描 Pi 根目录的 sessions 子树并为有效会话附项目键。
pub(super) fn collect_pi_session_files(root: &Path) -> Vec<SessionFileRef> {
    let sessions = root.join("sessions");
    if !sessions.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_files_recursive(&sessions, &mut files, &looks_like_pi_session_file);
    files
        .into_iter()
        .map(|path| SessionFileRef {
            source: "pi".to_string(),
            project_key: pi_project_key_from_path(&path),
            path,
        })
        .collect()
}

// 递归收集符合 Kiro 内容结构的 JSON 会话，排除 sessions.json 索引。
pub(super) fn collect_kiro_session_files(root: &Path) -> Vec<SessionFileRef> {
    if !root.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_files_recursive(root, &mut files, &|file_path| {
        is_json(file_path)
            && !file_path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("sessions.json"))
            && looks_like_kiro_session_file(file_path)
    });
    files
        .into_iter()
        .map(|path| SessionFileRef {
            source: "kiro".to_string(),
            project_key: kiro_project_key_from_path(&path),
            path,
        })
        .collect()
}

// 优先扫描 Cline tasks 候选目录，按规范路径去重并附项目键。
pub(super) fn collect_cline_session_files(root: &Path) -> Vec<SessionFileRef> {
    if !root.exists() {
        return Vec::new();
    }

    let mut scan_roots = Vec::new();
    for candidate in [root.join("tasks"), root.join("data").join("tasks")] {
        if candidate.is_dir() {
            scan_roots.push(candidate);
        }
    }
    if scan_roots.is_empty() {
        scan_roots.push(root.to_path_buf());
    }

    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for scan_root in scan_roots {
        collect_files_recursive(&scan_root, &mut files, &looks_like_cline_session_file);
    }

    files
        .into_iter()
        .filter(|path| seen.insert(normalize_history_path(&path.to_string_lossy())))
        .map(|path| SessionFileRef {
            source: "cline".to_string(),
            project_key: cline_project_key_from_path(&path),
            path,
        })
        .collect()
}

// 递归收集 Cursor agent transcript 并附项目目录键。
pub(super) fn collect_cursor_session_files(root: &Path) -> Vec<SessionFileRef> {
    if !root.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_files_recursive(root, &mut files, &looks_like_cursor_agent_transcript_file);
    files
        .into_iter()
        .map(|path| SessionFileRef {
            source: "cursor".to_string(),
            project_key: cursor_project_key_from_path(&path),
            path,
        })
        .collect()
}
use std::fs;
