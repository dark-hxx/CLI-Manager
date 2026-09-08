use super::{
    collect_session_files, get_or_scan_session_project, is_jsonl, kimi, project_key_from_cwd,
    resolve_antigravity_history_root, resolve_claude_history_root, resolve_codex_history_root,
    resolve_copilot_history_root, resolve_cursor_history_root, resolve_gemini_history_root,
    resolve_grok_history_root, resolve_kiro_history_root, resolve_pi_history_root, HistoryRoots,
    SessionFileRef,
};
use log::{debug, warn};
use std::path::{Path, PathBuf};

// 规范化来源和历史根目录，再用目录清单验证请求路径与项目身份。
pub(crate) fn validate_session_file_ref(
    file_path: &str,
    source: &str,
    project_key: &str,
    roots: &HistoryRoots,
) -> Result<SessionFileRef, String> {
    let source = source.trim().to_lowercase();
    let project_key = project_key.trim();
    let base = history_source_base(&source, roots)?
        .canonicalize()
        .map_err(|_| "history_source_not_found".to_string())?;
    resolve_session_file_ref(
        file_path,
        &source,
        project_key,
        &base,
        collect_session_files(Some(&source), roots),
    )
}

// 验证转换输入的非空项目键及 JSONL 规范路径属于来源根目录，不要求索引命中。
pub(super) fn validate_session_file_ref_for_conversion(
    file_path: &str,
    source: &str,
    project_key: &str,
    roots: &HistoryRoots,
) -> Result<SessionFileRef, String> {
    let source = source.trim().to_lowercase();
    let project_key = project_key.trim();
    if project_key.is_empty() {
        return Err("invalid_project_key".to_string());
    }

    let base = history_source_base(&source, roots)?
        .canonicalize()
        .map_err(|_| "history_source_not_found".to_string())?;
    let requested = PathBuf::from(file_path);
    if !is_jsonl(&requested) {
        return Err("invalid_session_file".to_string());
    }
    let requested = requested
        .canonicalize()
        .map_err(|_| format!("Session file not found: {file_path}"))?;
    if !path_within_history_scope(&requested, &base) {
        return Err("session_file_outside_history_scope".to_string());
    }

    Ok(SessionFileRef {
        source,
        project_key: project_key.to_string(),
        path: requested,
    })
}

// 将支持的文件历史来源映射到对应根目录，不支持的来源返回错误。
pub(super) fn history_source_base(source: &str, roots: &HistoryRoots) -> Result<PathBuf, String> {
    match source {
        "claude" => Ok(resolve_claude_history_root(roots)),
        "codex" => Ok(resolve_codex_history_root(roots)),
        "gemini" => Ok(resolve_gemini_history_root()),
        "copilot" => Ok(resolve_copilot_history_root()),
        "antigravity" => Ok(resolve_antigravity_history_root()),
        "grok" => Ok(resolve_grok_history_root(roots)),
        "kimi" => Ok(kimi::resolve_kimi_history_root(roots)),
        "pi" => Ok(resolve_pi_history_root()),
        "kiro" => Ok(resolve_kiro_history_root()),
        "cursor" => Ok(resolve_cursor_history_root()),
        _ => Err("unsupported_history_source".to_string()),
    }
}

// 按不区分 ASCII 大小写的扩展名接受 JSON 或 JSONL 路径。
pub(super) fn is_supported_session_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("jsonl") || value.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

// 校验规范路径位于历史范围，并在候选清单中匹配来源、实际路径与项目键。
pub(super) fn resolve_session_file_ref(
    file_path: &str,
    source: &str,
    project_key: &str,
    history_base: &Path,
    candidates: Vec<SessionFileRef>,
) -> Result<SessionFileRef, String> {
    if project_key.is_empty() {
        return Err("invalid_project_key".to_string());
    }

    let requested = PathBuf::from(file_path);
    if !is_supported_session_file(&requested) {
        return Err("invalid_session_file".to_string());
    }

    debug!(
        "history session scope validation start: source={}, project_key={}, requested_raw={}, history_base_raw={}",
        source,
        project_key,
        file_path,
        history_base.to_string_lossy()
    );

    let requested = requested
        .canonicalize()
        .map_err(|_| format!("Session file not found: {file_path}"))?;
    debug!(
        "history session scope canonicalized: source={}, project_key={}, requested={}, history_base={}",
        source,
        project_key,
        requested.to_string_lossy(),
        history_base.to_string_lossy()
    );
    if !path_within_history_scope(&requested, history_base) {
        warn!(
            "history session scope rejected: source={}, project_key={}, requested={}, history_base={}, requested_scope={}, history_scope={}",
            source,
            project_key,
            requested.to_string_lossy(),
            history_base.to_string_lossy(),
            history_scope_debug_string(&requested),
            history_scope_debug_string(history_base)
        );
        return Err("session_file_outside_history_scope".to_string());
    }

    for candidate in candidates {
        if candidate.source != source {
            continue;
        }
        let Ok(candidate_path) = candidate.path.canonicalize() else {
            continue;
        };
        if candidate_path != requested {
            continue;
        }

        let indexed_project_key = candidate.project_key;
        let resolved_project_key = if source != "claude" {
            get_or_scan_session_project(&candidate_path)
                .cwd
                .as_deref()
                .and_then(project_key_from_cwd)
                .unwrap_or_else(|| indexed_project_key.clone())
        } else {
            indexed_project_key.clone()
        };
        if resolved_project_key != project_key {
            continue;
        }

        debug!(
            "history session scope matched indexed candidate: source={}, project_key={}, indexed_project_key={}, requested={}, candidate={}",
            source,
            resolved_project_key,
            indexed_project_key,
            requested.to_string_lossy(),
            candidate_path.to_string_lossy()
        );
        return Ok(SessionFileRef {
            source: candidate.source,
            project_key: resolved_project_key,
            path: requested,
        });
    }

    Err("session_file_not_indexed".to_string())
}

// 按路径组件判断历史范围，WSL 路径额外统一发行版标识比较。
pub(super) fn path_within_history_scope(requested: &Path, history_base: &Path) -> bool {
    let requested_scope = wsl_scope_path_parts(requested);
    let history_scope = wsl_scope_path_parts(history_base);

    if let (Some((requested_distro, requested_linux)), Some((base_distro, base_linux))) =
        (requested_scope.as_ref(), history_scope.as_ref())
    {
        let accepted = requested_distro.eq_ignore_ascii_case(base_distro)
            && Path::new(requested_linux).starts_with(Path::new(base_linux));
        debug!(
            "history session scope wsl compare: requested_raw={}, history_base_raw={}, requested_scope={}, history_scope={}, accepted={}",
            requested.to_string_lossy(),
            history_base.to_string_lossy(),
            format_wsl_scope_parts(requested_scope.as_ref()),
            format_wsl_scope_parts(history_scope.as_ref()),
            accepted
        );
        return accepted;
    }

    let accepted = requested.starts_with(history_base);
    debug!(
        "history session scope native compare: requested_raw={}, history_base_raw={}, requested_scope={}, history_scope={}, accepted={}",
        requested.to_string_lossy(),
        history_base.to_string_lossy(),
        format_wsl_scope_parts(requested_scope.as_ref()),
        format_wsl_scope_parts(history_scope.as_ref()),
        accepted
    );
    accepted
}

// 规范化 WSL UNC 写法并解析发行版与 Linux 路径。
pub(super) fn wsl_scope_path_parts(path: &Path) -> Option<(String, String)> {
    let raw = path.to_string_lossy();
    let normalized = normalize_wsl_scope_unc(&raw);
    crate::wsl::parse_wsl_unc_path(&normalized)
}

// 生成原始路径、规范写法及 WSL 解析结果的诊断文本。
pub(super) fn history_scope_debug_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let normalized = normalize_wsl_scope_unc(&raw);
    let parsed = crate::wsl::parse_wsl_unc_path(&normalized);
    format!(
        "raw={} | normalized={} | parsed={}",
        raw,
        normalized,
        format_wsl_scope_parts(parsed.as_ref())
    )
}

// 将可选 WSL 路径分解结果格式化为诊断字符串。
pub(super) fn format_wsl_scope_parts(parts: Option<&(String, String)>) -> String {
    parts
        .map(|(distro, linux)| format!("Some(distro={distro}, linux={linux})"))
        .unwrap_or_else(|| "None".to_string())
}

// 统一分隔符，并将 WSL 扩展 UNC 前缀转换为普通 UNC 写法。
pub(super) fn normalize_wsl_scope_unc(path: &str) -> String {
    let normalized = path.trim().replace('/', "\\");
    let lower = normalized.to_ascii_lowercase();
    const VERBATIM_WSL_LOCALHOST_PREFIX: &str = "\\\\?\\UNC\\wsl.localhost\\";
    const VERBATIM_WSL_DOLLAR_PREFIX: &str = "\\\\?\\UNC\\wsl$\\";
    const VERBATIM_UNC_PREFIX_LEN: usize = "\\\\?\\UNC\\".len();

    if lower.starts_with(&VERBATIM_WSL_LOCALHOST_PREFIX.to_ascii_lowercase())
        || lower.starts_with(&VERBATIM_WSL_DOLLAR_PREFIX.to_ascii_lowercase())
    {
        return format!("\\\\{}", &normalized[VERBATIM_UNC_PREFIX_LEN..]);
    }

    normalized
}

// 对可识别的 WSL UNC 路径返回其 Linux 部分。
pub(super) fn wsl_linux_path(path: &Path) -> Option<String> {
    let raw = path.to_string_lossy();
    let normalized = normalize_wsl_scope_unc(&raw);
    crate::wsl::parse_wsl_unc_path(&normalized).map(|(_, linux_path)| linux_path)
}

// 将 WSL 路径转换为 CLI 可用的 Linux 路径，其他路径保留原表示。
pub(super) fn codex_runtime_path(path: &Path) -> String {
    wsl_linux_path(path).unwrap_or_else(|| path.to_string_lossy().into_owned())
}

// 仅对非 WSL UNC 路径允许走本地 Codex 状态库注册。
pub(super) fn should_register_codex_state_db(path: &Path) -> bool {
    wsl_linux_path(path).is_none()
}
