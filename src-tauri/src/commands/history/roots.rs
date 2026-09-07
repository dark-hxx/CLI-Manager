use super::{
    codex_config_string, detect_home_dir, excerpt, expand_codex_config_path,
    get_or_scan_session_project, read_dir_entries, remember_wsl_session_fingerprint,
    scan_file_changes, scan_session_computation_with_messages,
    scan_session_detail_parts_with_thread_names, scan_tool_events, session_file_fingerprint,
    system_time_to_millis, wsl_command_text, wsl_find_session_files, wsl_session_fingerprint,
    CachedSessionComputation, CodexThreadNameIndex, HistoryRoots, SessionDetailParts,
    SessionFileRef, CODEX_THREAD_NAME_INDEX_MAX_BYTES,
};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};

pub(super) fn list_subagent_transcript_files(subagents_dir: &Path) -> Vec<PathBuf> {
    let dir_str = subagents_dir.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&dir_str) {
        if let Some((distro, linux_dir)) = crate::wsl::parse_wsl_unc_path(&dir_str) {
            return wsl_find_session_files(&linux_dir, &distro, "agent-*.jsonl", &|_| {
                "subagent".to_string()
            })
            .into_iter()
            .map(|hit| {
                let unc = crate::wsl::linux_to_unc_wsl_path(&hit.linux_path, &distro);
                remember_wsl_session_fingerprint(&unc, hit.fingerprint);
                PathBuf::from(unc)
            })
            .collect();
        }
    }
    if !subagents_dir.exists() {
        return Vec::new();
    }
    read_dir_entries(subagents_dir)
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| is_subagent_transcript_path(path))
        .collect()
}

pub(crate) fn is_subagent_transcript_path(path: &Path) -> bool {
    let is_subagents_dir = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("subagents"))
        .unwrap_or(false);
    let is_agent_file = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
        .unwrap_or(false);
    is_subagents_dir && is_agent_file
}

pub(crate) fn history_roots(
    claude_config_dir: Option<String>,
    codex_config_dir: Option<String>,
    grok_session_root: Option<String>,
) -> HistoryRoots {
    HistoryRoots {
        claude_config_dir: normalize_config_dir(claude_config_dir),
        codex_config_dir: normalize_config_dir(codex_config_dir),
        grok_session_root: normalize_config_dir(grok_session_root),
        kimi_config_dir: None,
    }
}

pub(super) fn normalize_config_dir(value: Option<String>) -> Option<PathBuf> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(super) fn resolve_claude_history_root(roots: &HistoryRoots) -> PathBuf {
    if let Some(dir) = roots.claude_config_dir.clone() {
        return dir.join("projects");
    }
    crate::provider::home::default_history_root("claude")
        .or_else(|| detect_home_dir().map(|home| home.join(".claude").join("projects")))
        .unwrap_or_else(|| PathBuf::from(".claude").join("projects"))
}

pub(super) fn resolve_codex_config_root(roots: &HistoryRoots) -> PathBuf {
    roots
        .codex_config_dir
        .clone()
        .or_else(|| crate::provider::home::default_config_root("codex"))
        .or_else(|| detect_home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

pub(super) fn codex_thread_name_index(roots: &HistoryRoots) -> CodexThreadNameIndex {
    let path = resolve_codex_config_root(roots).join("session_index.jsonl");
    let path_text = path.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&path_text) {
        let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path_text) else {
            return CodexThreadNameIndex {
                names: HashMap::new(),
                fingerprint: "wsl-invalid".to_string(),
            };
        };
        let fingerprint = wsl_session_fingerprint(&linux_path, &distro);
        let fingerprint_text = format!(
            "wsl:{}:{}:{}",
            fingerprint.created_at, fingerprint.updated_at, fingerprint.size
        );
        if fingerprint.size > CODEX_THREAD_NAME_INDEX_MAX_BYTES {
            return CodexThreadNameIndex {
                names: HashMap::new(),
                fingerprint: format!("{fingerprint_text}:oversized"),
            };
        }
        let wsl_exe = crate::wsl::find_wsl_exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "wsl.exe".to_string());
        let args = ["-d", distro.as_str(), "--exec", "cat", linux_path.as_str()];
        let names = wsl_command_text(&wsl_exe, &args)
            .ok()
            .filter(|(text, _)| text.as_bytes().len() as u64 <= CODEX_THREAD_NAME_INDEX_MAX_BYTES)
            .map(|(text, _)| parse_codex_thread_name_index(&text))
            .unwrap_or_default();
        return CodexThreadNameIndex {
            names,
            fingerprint: fingerprint_text,
        };
    }

    let metadata = fs::metadata(&path).ok();
    let fingerprint = metadata
        .as_ref()
        .map(|metadata| {
            format!(
                "local:{}:{}:{}",
                metadata
                    .modified()
                    .ok()
                    .map(system_time_to_millis)
                    .unwrap_or_default(),
                metadata.len(),
                metadata
                    .created()
                    .ok()
                    .map(system_time_to_millis)
                    .unwrap_or_default(),
            )
        })
        .unwrap_or_else(|| "local:missing".to_string());
    let Some(metadata) = metadata else {
        return CodexThreadNameIndex {
            names: HashMap::new(),
            fingerprint,
        };
    };
    if metadata.len() > CODEX_THREAD_NAME_INDEX_MAX_BYTES {
        return CodexThreadNameIndex {
            names: HashMap::new(),
            fingerprint: format!("{fingerprint}:oversized"),
        };
    }
    let names = fs::read(&path)
        .ok()
        .filter(|bytes| bytes.len() as u64 <= CODEX_THREAD_NAME_INDEX_MAX_BYTES)
        .map(|bytes| parse_codex_thread_name_index(&String::from_utf8_lossy(&bytes)))
        .unwrap_or_default();
    CodexThreadNameIndex { names, fingerprint }
}

pub(super) fn parse_codex_thread_name_index(text: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(session_id) = value
            .get("id")
            .or_else(|| value.get("session_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(thread_name) = value
            .get("thread_name")
            .or_else(|| value.get("threadName"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        names.insert(session_id.to_string(), excerpt(thread_name, 80));
    }
    names
}

pub(super) fn apply_codex_thread_name(
    file_ref: &SessionFileRef,
    index: &CodexThreadNameIndex,
    computed: &mut CachedSessionComputation,
) {
    if file_ref.source != "codex" {
        return;
    }
    if let Some(thread_name) = index.names.get(&computed.session_id) {
        computed.title = thread_name.clone();
    }
}

pub(super) fn scan_session_detail_parts(file_ref: &SessionFileRef) -> SessionDetailParts {
    let fingerprint = session_file_fingerprint(&file_ref.path);
    let (computed, messages) = scan_session_computation_with_messages(
        &file_ref.path,
        fingerprint.created_at,
        fingerprint.updated_at,
    );
    let tool_events = scan_tool_events(&file_ref.path);
    let file_changes = scan_file_changes(&file_ref.path);
    SessionDetailParts {
        computed,
        cwd: get_or_scan_session_project(&file_ref.path).cwd,
        messages,
        tool_events,
        file_changes,
    }
}

pub(super) fn scan_session_detail_parts_for_roots(
    file_ref: &SessionFileRef,
    codex_thread_names: &CodexThreadNameIndex,
) -> SessionDetailParts {
    scan_session_detail_parts_with_thread_names(file_ref, codex_thread_names)
}

pub(super) fn resolve_codex_history_root(roots: &HistoryRoots) -> PathBuf {
    if roots.codex_config_dir.is_some() {
        return resolve_codex_config_root(roots).join("sessions");
    }
    crate::provider::home::default_history_root("codex")
        .or_else(|| detect_home_dir().map(|home| home.join(".codex").join("sessions")))
        .unwrap_or_else(|| PathBuf::from(".codex").join("sessions"))
}

pub(super) fn resolve_codex_state_db_path(roots: &HistoryRoots) -> PathBuf {
    let root = resolve_codex_config_root(roots);
    if let Some(sqlite_home) = codex_config_string(roots, "sqlite_home") {
        return expand_codex_config_path(&root, &sqlite_home).join("state_5.sqlite");
    }

    let default_path = root.join("state_5.sqlite");
    if default_path.exists() {
        return default_path;
    }
    let nested_path = root.join("sqlite").join("state_5.sqlite");
    if nested_path.exists() {
        return nested_path;
    }
    default_path
}

pub(super) fn resolve_gemini_history_root() -> PathBuf {
    detect_home_dir()
        .map(|home| home.join(".gemini").join("tmp"))
        .unwrap_or_else(|| PathBuf::from(".gemini").join("tmp"))
}

pub(super) fn resolve_copilot_history_root() -> PathBuf {
    detect_home_dir()
        .map(|home| home.join(".copilot").join("session-state"))
        .unwrap_or_else(|| PathBuf::from(".copilot").join("session-state"))
}

pub(super) fn resolve_antigravity_history_root() -> PathBuf {
    let home = detect_home_dir().unwrap_or_default();
    let primary = home.join(".gemini").join("antigravity-cli");
    let legacy = home.join(".gemini").join("antigravity");
    if primary.join("brain").exists() {
        primary
    } else if legacy.join("brain").exists() {
        legacy
    } else {
        primary
    }
}

pub(super) fn resolve_grok_history_root(roots: &HistoryRoots) -> PathBuf {
    roots.grok_session_root.clone().unwrap_or_else(|| {
        crate::provider::home::default_history_root("grok")
            .or_else(|| detect_home_dir().map(|home| home.join(".grok").join("sessions")))
            .unwrap_or_else(|| PathBuf::from(".grok").join("sessions"))
    })
}

pub(super) fn resolve_pi_history_root() -> PathBuf {
    detect_home_dir()
        .map(|home| home.join(".pi").join("agent"))
        .unwrap_or_else(|| PathBuf::from(".pi").join("agent"))
}

pub(super) fn resolve_cline_history_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    #[cfg(target_os = "windows")]
    if let Some(app_data) = env::var_os("APPDATA").filter(|value| !value.is_empty()) {
        for app in ["Code", "Cursor"] {
            for extension in ["saoudrizwan.claude-dev", "cline.cline"] {
                roots.push(
                    PathBuf::from(&app_data)
                        .join(app)
                        .join("User")
                        .join("globalStorage")
                        .join(extension),
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = detect_home_dir() {
        for app in ["Code", "Cursor"] {
            for extension in ["saoudrizwan.claude-dev", "cline.cline"] {
                roots.push(
                    home.join("Library")
                        .join("Application Support")
                        .join(app)
                        .join("User")
                        .join("globalStorage")
                        .join(extension),
                );
            }
        }
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    if let Some(home) = detect_home_dir() {
        for app in ["Code", "Cursor"] {
            for extension in ["saoudrizwan.claude-dev", "cline.cline"] {
                roots.push(
                    home.join(".config")
                        .join(app)
                        .join("User")
                        .join("globalStorage")
                        .join(extension),
                );
            }
        }
    }

    roots.push(
        detect_home_dir()
            .map(|home| home.join(".cline"))
            .unwrap_or_else(|| PathBuf::from(".cline")),
    );
    roots
}

pub(super) fn resolve_cursor_history_root() -> PathBuf {
    detect_home_dir()
        .map(|home| home.join(".cursor").join("projects"))
        .unwrap_or_else(|| PathBuf::from(".cursor").join("projects"))
}

pub(super) fn resolve_cursor_global_storage_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = env::var_os("APPDATA").filter(|value| !value.is_empty()) {
            return PathBuf::from(app_data)
                .join("Cursor")
                .join("User")
                .join("globalStorage");
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = detect_home_dir() {
        return home
            .join("Library")
            .join("Application Support")
            .join("Cursor")
            .join("User")
            .join("globalStorage");
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    if let Some(home) = detect_home_dir() {
        return home
            .join(".config")
            .join("Cursor")
            .join("User")
            .join("globalStorage");
    }
    PathBuf::from("Cursor").join("User").join("globalStorage")
}

pub(super) fn resolve_kiro_history_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = env::var_os("APPDATA").filter(|value| !value.is_empty()) {
            return PathBuf::from(app_data)
                .join("Kiro")
                .join("User")
                .join("globalStorage")
                .join("kiro.kiroagent")
                .join("workspace-sessions");
        }
    }
    detect_home_dir()
        .map(|home| home.join(".kiro").join("workspace-sessions"))
        .unwrap_or_else(|| PathBuf::from(".kiro").join("workspace-sessions"))
}
use std::fs;
