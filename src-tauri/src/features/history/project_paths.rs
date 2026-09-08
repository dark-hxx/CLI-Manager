use super::{
    antigravity_workspace_from_path, can_reuse_session_scan, cline_workspace_from_path,
    cursor_metadata_from_path, cursor_project_slug_from_path, get_project_cache,
    grok_workspace_from_path, kimi, looks_like_antigravity_transcript_file,
    looks_like_cline_session_file, looks_like_cursor_agent_transcript_file,
    looks_like_grok_updates_file, looks_like_pi_session_file, pi_workspace_from_path,
    session_file_fingerprint, CachedSessionProjectCacheEntry, SessionFileRef, SessionProjectScan,
    READ_BUF_CAPACITY,
};
use log::{debug, warn};
use serde_json::Value;
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

// 优先从会话 cwd 提取项目名，缺失时使用相对历史目录键。
pub(super) fn codex_project_key_from_session(path: &Path, root: &Path) -> String {
    get_or_scan_session_project(path)
        .cwd
        .as_deref()
        .and_then(project_key_from_cwd)
        .unwrap_or_else(|| codex_project_key_from_path(path, root))
}

// 从 Gemini 会话上两级目录相对根目录的首个组件取项目键。
pub(super) fn gemini_project_key_from_path(path: &Path, root: &Path) -> String {
    path.parent()
        .and_then(Path::parent)
        .and_then(|parent| parent.strip_prefix(root).ok())
        .and_then(|relative| relative.components().next())
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "gemini".to_string())
}

// 优先从 Copilot 会话 cwd 取项目键，再回退父目录名或来源名。
pub(super) fn copilot_project_key_from_path(path: &Path) -> String {
    get_or_scan_session_project(path)
        .cwd
        .as_deref()
        .and_then(project_key_from_cwd)
        .or_else(|| {
            path.parent()
                .and_then(|parent| parent.file_name())
                .map(|name| name.to_string_lossy().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "copilot".to_string())
}

// 优先从 Kiro 会话 cwd 取项目键，再回退父目录名或来源名。
pub(super) fn kiro_project_key_from_path(path: &Path) -> String {
    get_or_scan_session_project(path)
        .cwd
        .as_deref()
        .and_then(project_key_from_cwd)
        .or_else(|| {
            path.parent()
                .and_then(|parent| parent.file_name())
                .map(|name| name.to_string_lossy().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "kiro".to_string())
}

// 取工作目录最后一个有效非盘符组件作为项目名。
pub(super) fn project_key_from_cwd(cwd: &str) -> Option<String> {
    let normalized = cwd.trim().replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    trimmed
        .rsplit('/')
        .find(|segment| {
            let segment = segment.trim();
            !segment.is_empty() && segment != "." && segment != ".." && !segment.ends_with(':')
        })
        .map(|segment| segment.trim().to_string())
}

// 将会话父目录相对历史根目录的路径转为项目键，空值回退 sessions。
pub(super) fn codex_project_key_from_path(path: &Path, root: &Path) -> String {
    path.parent()
        .and_then(|parent| parent.strip_prefix(root).ok())
        .map(path_to_key)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "sessions".to_string())
}

// 递归遍历目录并收集满足谓词的非目录路径。
pub(super) fn collect_files_recursive(
    dir: &Path,
    output: &mut Vec<PathBuf>,
    predicate: &dyn Fn(&Path) -> bool,
) {
    for entry in read_dir_entries(dir) {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, output, predicate);
        } else if predicate(&path) {
            output.push(path);
        }
    }
}

// 收集成功读取的目录项，目录打开失败时记录警告并返回空列表。
pub(super) fn read_dir_entries(dir: &Path) -> Vec<fs::DirEntry> {
    match fs::read_dir(dir) {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(e) => {
            warn!(
                "[wsl] fs::read_dir 失败: dir={} error={e} — 若路径为 WSL UNC 可能因 Plan 9 协议限制",
                dir.to_string_lossy()
            );
            Vec::new()
        }
    }
}

// 按不区分 ASCII 大小写的扩展名判断 JSONL 路径。
pub(super) fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .map(|v| v.to_string_lossy().eq_ignore_ascii_case("jsonl"))
        .unwrap_or(false)
}

// 按不区分 ASCII 大小写的扩展名判断 JSON 路径。
pub(super) fn is_json(path: &Path) -> bool {
    path.extension()
        .map(|v| v.to_string_lossy().eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

// 按平台优先级从非空 USERPROFILE 或 HOME 环境变量解析用户目录。
pub(super) fn detect_home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("HOME")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
            })
    }
    #[cfg(not(target_os = "windows"))]
    {
        env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("USERPROFILE")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
            })
    }
}

// 将路径转换为损失容忍的字符串并统一使用正斜杠。
pub(super) fn path_to_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

// 修剪路径并统一分隔符，Windows 上额外转为小写以便比较。
pub(super) fn normalize_history_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let normalized = normalized.trim_end_matches('/').to_string();
    if cfg!(target_os = "windows") {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

// 把项目路径编码为小写的 Claude 目录键。
pub(super) fn claude_project_key_from_path(path: &str) -> String {
    path.trim()
        .replace(':', "-")
        .replace(['\\', '/'], "-")
        .trim_end_matches('-')
        .to_lowercase()
}

// 匹配来源目录键或扫描 cwd，同时考虑 Windows 与 WSL 路径候选及子目录。
pub(super) fn session_matches_project_path(
    file_ref: &SessionFileRef,
    target_project_path: &str,
) -> bool {
    // 目标项目路径可能是 Windows 形式（D:\..），而 claude 在 WSL 内按 Linux cwd
    // (/mnt/d/..) 编码会话目录，故同时尝试 Windows 与 WSL 两种形式——二者指向同一物理
    // 目录，任一命中即视为同项目。target_project_path 已被 normalize_history_path 归一化。
    let wsl_target = crate::wsl::windows_path_to_wsl(target_project_path);
    // WSL UNC 路径（\\wsl.localhost\...）也需要转成 Linux 形式做 project_key 匹配。
    let wsl_unc_linux_target =
        crate::wsl::parse_wsl_unc_path(target_project_path).map(|(_distro, linux_path)| linux_path);

    if let Some(ref linux_path) = wsl_unc_linux_target {
        debug!(
            "[wsl] 项目路径匹配: target={target_project_path} wsl_linux={linux_path} source={} key={}",
            file_ref.source,
            file_ref.project_key
        );
    }

    if file_ref.source == "claude" {
        let key = file_ref.project_key.to_lowercase();
        if key == claude_project_key_from_path(target_project_path) {
            debug!(
                "session_matches_project_path matched claude key: target={} source={} project_key={} file={}",
                target_project_path,
                file_ref.source,
                file_ref.project_key,
                file_ref.path.to_string_lossy()
            );
            return true;
        }
        if let Some(wsl_target) = wsl_target.as_deref() {
            if key == claude_project_key_from_path(wsl_target) {
                debug!(
                    "session_matches_project_path matched claude wsl target: target={} wsl_target={} source={} project_key={} file={}",
                    target_project_path,
                    wsl_target,
                    file_ref.source,
                    file_ref.project_key,
                    file_ref.path.to_string_lossy()
                );
                return true;
            }
        }
        if let Some(ref linux_target) = wsl_unc_linux_target {
            if key == claude_project_key_from_path(linux_target) {
                debug!(
                    "session_matches_project_path matched claude unc target: target={} linux_target={} source={} project_key={} file={}",
                    target_project_path,
                    linux_target,
                    file_ref.source,
                    file_ref.project_key,
                    file_ref.path.to_string_lossy()
                );
                return true;
            }
        }
    }
    if file_ref.source == "cursor" {
        let key = file_ref.project_key.to_lowercase();
        if key == cursor_project_slug_from_path(target_project_path) {
            return true;
        }
        if let Some(wsl_target) = wsl_target.as_deref() {
            if key == cursor_project_slug_from_path(wsl_target) {
                return true;
            }
        }
        if let Some(ref linux_target) = wsl_unc_linux_target {
            if key == cursor_project_slug_from_path(linux_target) {
                return true;
            }
        }
    }

    let scan = get_or_scan_session_project(&file_ref.path);
    let normalized_cwd = scan.cwd.as_deref().map(normalize_history_path);
    let matched = normalized_cwd
        .as_deref()
        .map(|cwd| {
            cwd_matches_target(&cwd, target_project_path)
                || wsl_target
                    .as_deref()
                    .is_some_and(|target| cwd_matches_target(&cwd, target))
                || wsl_unc_linux_target
                    .as_deref()
                    .is_some_and(|target| cwd_matches_target(&cwd, target))
        })
        .unwrap_or(false);
    debug!(
        "session_matches_project_path result: target={} wsl_target={:?} unc_linux_target={:?} source={} project_key={} cwd={:?} file={} matched={}",
        target_project_path,
        wsl_target,
        wsl_unc_linux_target,
        file_ref.source,
        file_ref.project_key,
        normalized_cwd,
        file_ref.path.to_string_lossy(),
        matched
    );
    matched
}

// 判断已规范化工作目录等于目标或位于目标的子目录。
pub(super) fn cwd_matches_target(cwd: &str, target: &str) -> bool {
    cwd == target || cwd.starts_with(&format!("{target}/"))
}

// 按文件指纹复用项目元数据缓存，未命中时扫描并更新缓存。
pub(super) fn get_or_scan_session_project(path: &Path) -> SessionProjectScan {
    let fingerprint = session_file_fingerprint(path);
    let key = path_to_key(path);

    if let Ok(cache) = get_project_cache().lock() {
        if let Some(existing) = cache.entries.get(&key) {
            if can_reuse_session_scan(existing.fingerprint, fingerprint) {
                return existing.scan.clone();
            }
        }
    }

    let scan = scan_session_project(path);
    if let Ok(mut cache) = get_project_cache().lock() {
        cache.entries.insert(
            key,
            CachedSessionProjectCacheEntry {
                fingerprint,
                scan: scan.clone(),
            },
        );
    }
    scan
}

// 按来源读取项目元数据，普通 JSONL 从首个包含 cwd 的可解析记录取工作目录。
pub(super) fn scan_session_project(path: &Path) -> SessionProjectScan {
    if looks_like_antigravity_transcript_file(path) {
        return SessionProjectScan {
            cwd: antigravity_workspace_from_path(path),
        };
    }
    if looks_like_grok_updates_file(path) {
        return SessionProjectScan {
            cwd: grok_workspace_from_path(path),
        };
    }
    if kimi::looks_like_kimi_main_wire(path) {
        return kimi::scan_kimi_project(path);
    }
    if looks_like_pi_session_file(path) {
        return SessionProjectScan {
            cwd: pi_workspace_from_path(path),
        };
    }
    if looks_like_cline_session_file(path) {
        return SessionProjectScan {
            cwd: cline_workspace_from_path(path),
        };
    }
    if looks_like_cursor_agent_transcript_file(path) {
        if let Some(cwd) = cursor_metadata_from_path(path).and_then(|metadata| metadata.cwd) {
            return SessionProjectScan { cwd: Some(cwd) };
        }
    }
    if !is_jsonl(path) {
        return fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| extract_cwd(&value))
            .map(|cwd| SessionProjectScan { cwd: Some(cwd) })
            .unwrap_or_default();
    }

    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return SessionProjectScan::default(),
    };

    for line in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
    {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("cwd") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(cwd) = extract_cwd(&value) {
            debug!(
                "scan_session_project extracted cwd: path={} cwd={}",
                path.to_string_lossy(),
                cwd
            );
            return SessionProjectScan { cwd: Some(cwd) };
        }
    }

    debug!(
        "scan_session_project no cwd found: path={}",
        path.to_string_lossy()
    );
    SessionProjectScan::default()
}

// 从兼容工作目录字段或指定嵌套对象递归提取首个非空字符串。
pub(super) fn extract_cwd(value: &Value) -> Option<String> {
    let candidates = [
        value.get("cwd"),
        value.get("current_dir"),
        value.get("currentDir"),
        value.get("workdir"),
        value.get("working_dir"),
        value.get("workingDirectory"),
        value.get("workspaceDirectory"),
        value.get("workspacePath"),
        value.get("projectPath"),
    ];
    for candidate in candidates.into_iter().flatten() {
        let Some(path) = candidate.as_str().map(str::trim).filter(|v| !v.is_empty()) else {
            continue;
        };
        return Some(path.to_string());
    }

    for key in [
        "payload",
        "metadata",
        "environment_context",
        "data",
        "context",
    ] {
        if let Some(cwd) = value.get(key).and_then(extract_cwd) {
            return Some(cwd);
        }
    }

    None
}

// 按 rollout- 前缀和 .jsonl 后缀识别 Codex rollout 文件名。
pub(super) fn is_codex_rollout_session_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        .unwrap_or(false)
}

// 从 session_meta 记录的 payload.id 提取非空会话标识。
pub(super) fn extract_session_meta_id(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    value
        .get("payload")
        .and_then(|payload| payload.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}
