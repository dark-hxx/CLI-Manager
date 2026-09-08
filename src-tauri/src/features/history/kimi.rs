use super::{
    calculate_usage_cost, detect_home_dir, empty_session_scan, extract_text_from_value,
    extract_timestamp_millis, extract_usage_tokens, json_history_message, json_session_scan_result,
    make_tool_event, mark_tool_event_seen, normalize_history_path, normalize_text,
    parse_timestamp_millis_value, path_within_history_scope, read_dir_entries,
    remember_wsl_session_fingerprint, scan_session_computation, session_file_fingerprint,
    session_matches_project_path, summarize_json_value, summary_from_computation,
    timestamp_millis_to_rfc3339, usage_total_tokens, usage_trend_point, wsl_command_text,
    wsl_find_session_files, CachedSessionComputation, HistoryMessage, HistoryRoots,
    HistorySessionSummary, HistoryToolEvent, SessionFileRef, SessionProjectScan, SessionStatsScan,
    UsageTokenScan, READ_BUF_CAPACITY,
};
use crate::commands::history_backup::{create_file_backup_snapshot, default_backup_root};
use log::warn;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

// 按显式配置、环境变量及用户目录优先级解析 Kimi 根目录。
pub(super) fn resolve_kimi_history_root(roots: &HistoryRoots) -> PathBuf {
    roots.kimi_config_dir.clone().unwrap_or_else(|| {
        std::env::var_os("KIMI_CODE_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| detect_home_dir().map(|home| home.join(".kimi-code")))
            .unwrap_or_else(|| PathBuf::from(".kimi-code"))
    })
}

// 识别 agents/main/wire.jsonl 结尾的主代理日志路径。
pub(super) fn looks_like_kimi_main_wire(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("wire.jsonl"))
        && path.parent().is_some_and(|parent| {
            parent
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("main"))
        })
        && path.parent().and_then(Path::parent).is_some_and(|agents| {
            agents
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("agents"))
        })
}

// 限制 Kimi 会话标识长度及字符集，拒绝路径分隔和父目录片段。
pub(super) fn is_valid_kimi_session_id(session_id: &str) -> bool {
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

// 从主代理日志路径回溯到所属会话目录。
pub(super) fn kimi_session_dir_from_wire(path: &Path) -> Option<PathBuf> {
    if !looks_like_kimi_main_wire(path) {
        return None;
    }
    path.parent()?.parent()?.parent().map(Path::to_path_buf)
}

// 枚举本地或 WSL 主代理日志，并排除索引墓碑会话。
pub(super) fn collect_kimi_session_files(home: &Path) -> Vec<SessionFileRef> {
    let home_str = home.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&home_str) {
        if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&home_str) {
            return collect_wsl_kimi_session_files(&linux_path, &distro);
        }
        warn!("[wsl] 路径检测为 WSL 但解析失败: {home_str}，不回退宿主递归");
        return Vec::new();
    }

    let sessions = home.join("sessions");
    if !sessions.exists() {
        return Vec::new();
    }
    let tombstoned = fs::read_to_string(home.join("session_index.jsonl"))
        .map(|raw| kimi_tombstoned_session_ids(&raw))
        .unwrap_or_default();

    let mut files = Vec::new();
    for workdir in read_dir_entries(&sessions) {
        let workdir_path = workdir.path();
        if !workdir_path.is_dir() {
            continue;
        }
        for session in read_dir_entries(&workdir_path) {
            let session_path = session.path();
            if !session_path.is_dir() {
                continue;
            }
            if !session_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .is_some_and(|id| is_valid_kimi_session_id(&id) && !tombstoned.contains(&id))
            {
                continue;
            }
            let wire = session_path.join("agents").join("main").join("wire.jsonl");
            if !looks_like_kimi_main_wire(&wire) || !wire.is_file() {
                continue;
            }
            files.push(kimi_file_ref(&wire));
        }
    }
    files
}

// 在 WSL 枚举主代理日志，过滤墓碑并缓存文件指纹。
fn collect_wsl_kimi_session_files(linux_home: &str, distro: &str) -> Vec<SessionFileRef> {
    let linux_sessions = format!("{}/sessions", linux_home.trim_end_matches('/'));
    let tombstoned = read_wsl_kimi_session_index(linux_home, distro)
        .map(|raw| kimi_tombstoned_session_ids(&raw))
        .unwrap_or_default();
    wsl_find_session_files(&linux_sessions, distro, "wire.jsonl", &|linux_path| {
        kimi_project_key_from_linux_path(linux_path)
    })
    .into_iter()
    .filter(|hit| {
        looks_like_kimi_linux_main_wire(&hit.linux_path)
            && kimi_session_id_from_linux_wire(&hit.linux_path)
                .is_some_and(|id| is_valid_kimi_session_id(&id) && !tombstoned.contains(&id))
    })
    .map(|hit| {
        let unc = crate::wsl::linux_to_unc_wsl_path(&hit.linux_path, distro);
        remember_wsl_session_fingerprint(&unc, hit.fingerprint);
        let path = PathBuf::from(unc);
        SessionFileRef {
            source: "kimi".to_string(),
            project_key: kimi_project_key_from_path(&path),
            path,
        }
    })
    .collect()
}

// 为主代理日志构造带项目键的 Kimi 文件引用。
fn kimi_file_ref(path: &Path) -> SessionFileRef {
    SessionFileRef {
        source: "kimi".to_string(),
        project_key: kimi_project_key_from_path(path),
        path: path.to_path_buf(),
    }
}

// 按有效会话标识精确查找 Kimi 会话，并校验范围与项目匹配。
pub(super) fn find_exact_kimi_session_in_root(
    home: &Path,
    session_id: &str,
    project_path: Option<&str>,
) -> Option<HistorySessionSummary> {
    if !is_valid_kimi_session_id(session_id) {
        return None;
    }
    let session_id = session_id.trim();
    let target_project_path = project_path
        .map(normalize_history_path)
        .filter(|value| !value.is_empty());

    let home_str = home.to_string_lossy();
    if crate::wsl::is_wsl_config_dir(&home_str) {
        let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&home_str) else {
            warn!("[wsl] 路径检测为 WSL 但解析失败: {home_str}，跳过 Kimi 精确直查");
            return None;
        };
        return find_exact_wsl_kimi_session(
            &linux_path,
            &distro,
            session_id,
            target_project_path.as_deref(),
        );
    }

    let Ok(canonical_home) = home.canonicalize() else {
        return None;
    };
    if fs::read_to_string(home.join("session_index.jsonl"))
        .ok()
        .is_some_and(|raw| kimi_tombstoned_session_ids(&raw).contains(session_id))
    {
        return None;
    }
    let mut candidates = Vec::new();
    if let Some(path) = wire_path_from_session_index(home, session_id) {
        candidates.push(path);
    }
    let sessions = home.join("sessions");
    for workdir in read_dir_entries(&sessions) {
        let wire = workdir
            .path()
            .join(session_id)
            .join("agents")
            .join("main")
            .join("wire.jsonl");
        if looks_like_kimi_main_wire(&wire) && wire.is_file() {
            candidates.push(wire);
        }
    }

    let mut seen = HashSet::new();
    for path in candidates {
        let Ok(canonical_path) = path.canonicalize() else {
            continue;
        };
        let key = normalize_history_path(&canonical_path.to_string_lossy());
        if !seen.insert(key) {
            continue;
        }
        if !path_within_history_scope(&canonical_path, &canonical_home) {
            continue;
        }
        if !looks_like_kimi_main_wire(&canonical_path) {
            continue;
        }
        let file_ref = kimi_file_ref(&canonical_path);
        if let Some(summary) =
            summary_if_exact_kimi_session(&file_ref, session_id, target_project_path.as_deref())
        {
            return Some(summary);
        }
    }
    None
}

// 结合 WSL 索引和精确查找定位非墓碑 Kimi 会话。
fn find_exact_wsl_kimi_session(
    linux_home: &str,
    distro: &str,
    session_id: &str,
    target_project_path: Option<&str>,
) -> Option<HistorySessionSummary> {
    if read_wsl_kimi_session_index(linux_home, distro)
        .is_some_and(|raw| kimi_tombstoned_session_ids(&raw).contains(session_id))
    {
        return None;
    }
    let mut candidates = Vec::new();
    if let Some(path) = wire_path_from_wsl_session_index(linux_home, distro, session_id) {
        candidates.push(path);
    }
    if let Some(path) = wsl_find_exact_kimi_wire(linux_home, distro, session_id) {
        candidates.push(path);
    }
    let mut seen = HashSet::new();
    for path in candidates {
        let key = normalize_history_path(&path.to_string_lossy());
        if !seen.insert(key) {
            continue;
        }
        let file_ref = kimi_file_ref(&path);
        if let Some(summary) =
            summary_if_exact_kimi_session(&file_ref, session_id, target_project_path)
        {
            return Some(summary);
        }
    }
    None
}

// 确认目录标识、项目及解析标识一致后返回会话摘要。
fn summary_if_exact_kimi_session(
    file_ref: &SessionFileRef,
    session_id: &str,
    target_project_path: Option<&str>,
) -> Option<HistorySessionSummary> {
    let dir_id = kimi_session_dir_from_wire(&file_ref.path)
        .and_then(|dir| {
            dir.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .filter(|id| id == session_id);
    if dir_id.is_none() {
        return None;
    }
    if target_project_path.is_some_and(|target| !session_matches_project_path(file_ref, target)) {
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
    Some(summary_from_computation(file_ref, &computed))
}

// 从最新活动索引定位本地日志，校验绝对路径与会话目录范围。
fn wire_path_from_session_index(home: &Path, session_id: &str) -> Option<PathBuf> {
    let index = home.join("session_index.jsonl");
    let raw = fs::read_to_string(index).ok()?;
    let value = latest_kimi_index_record(&raw, session_id)?;
    let session_dir = value
        .get("sessionDir")
        .or_else(|| value.get("session_dir"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let dir = PathBuf::from(session_dir);
    if !dir.is_absolute() {
        return None;
    }
    let canonical_sessions = home.join("sessions").canonicalize().ok()?;
    let canonical_dir = dir.canonicalize().ok()?;
    if !path_within_history_scope(&canonical_dir, &canonical_sessions)
        || canonical_dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .as_deref()
            != Some(session_id)
    {
        return None;
    }
    let wire = canonical_dir.join("agents").join("main").join("wire.jsonl");
    (looks_like_kimi_main_wire(&wire) && wire.is_file()).then_some(wire)
}

// 按日志顺序选取最新有效活动记录，并遵守删除墓碑。
fn latest_kimi_index_record(raw: &str, session_id: &str) -> Option<Value> {
    let mut latest = None;
    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if kimi_index_record_session_id(&value) != Some(session_id) {
            continue;
        }
        if value.get("deleted").and_then(Value::as_bool) == Some(true) {
            latest = None;
        } else if is_valid_kimi_active_index_record(&value) {
            latest = Some(value);
        }
    }
    latest
}

// 检查活动索引记录具备字符串会话目录与工作目录。
fn is_valid_kimi_active_index_record(value: &Value) -> bool {
    value
        .get("sessionDir")
        .or_else(|| value.get("session_dir"))
        .is_some_and(Value::is_string)
        && value
            .get("workDir")
            .or_else(|| value.get("workdir"))
            .or_else(|| value.get("cwd"))
            .is_some_and(Value::is_string)
}

// 重放会话索引，计算最终处于删除状态的会话标识。
fn kimi_tombstoned_session_ids(raw: &str) -> HashSet<String> {
    let mut tombstoned = HashSet::new();
    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(session_id) =
            kimi_index_record_session_id(&value).filter(|id| is_valid_kimi_session_id(id))
        else {
            continue;
        };
        if value.get("deleted").and_then(Value::as_bool) == Some(true) {
            tombstoned.insert(session_id.to_string());
        } else if is_valid_kimi_active_index_record(&value) {
            tombstoned.remove(session_id);
        }
    }
    tombstoned
}

// 从兼容字段提取非空的索引会话标识。
fn kimi_index_record_session_id(value: &Value) -> Option<&str> {
    value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

// 检查 Linux 路径符合 sessions 下的主代理日志层级。
fn looks_like_kimi_linux_main_wire(linux_path: &str) -> bool {
    let normalized = linux_path.replace('\\', "/");
    let parts: Vec<&str> = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let n = parts.len();
    n >= 6
        && parts[n - 1].eq_ignore_ascii_case("wire.jsonl")
        && parts[n - 2].eq_ignore_ascii_case("main")
        && parts[n - 3].eq_ignore_ascii_case("agents")
        && parts[n - 6].eq_ignore_ascii_case("sessions")
}

// 从 Linux 日志路径倒数第四段提取会话标识。
fn kimi_session_id_from_linux_wire(linux_path: &str) -> Option<String> {
    linux_path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .rev()
        .nth(3)
        .map(str::to_string)
}

// 统一路径分隔并折叠空段、当前目录及父目录片段。
fn normalize_linux_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut out = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            out.pop();
            continue;
        }
        out.push(part);
    }
    format!("/{}", out.join("/"))
}

// 规范化 Linux 路径后判断是否位于给定根目录内。
fn linux_path_within_home(path: &str, home: &str) -> bool {
    let path = normalize_linux_path(path);
    let home = normalize_linux_path(home);
    path == home || path.starts_with(&format!("{home}/"))
}

// 保留绝对会话目录，或将相对目录拼接到 Kimi 根目录。
fn resolve_linux_session_dir(linux_home: &str, session_dir: &str) -> String {
    if session_dir.replace('\\', "/").starts_with('/') {
        session_dir.trim_end_matches('/').to_string()
    } else {
        format!(
            "{}/{}",
            linux_home.trim_end_matches('/'),
            session_dir.trim_start_matches('/')
        )
    }
}

// 查找可用 WSL 程序并转换为字符串路径。
fn wsl_exe_string() -> Option<String> {
    crate::wsl::find_wsl_exe().map(|path| path.to_string_lossy().into_owned())
}

// 通过 WSL cat 读取 Kimi 会话索引，失败时返回空值。
fn read_wsl_kimi_session_index(linux_home: &str, distro: &str) -> Option<String> {
    let wsl_exe = wsl_exe_string()?;
    let index = format!("{}/session_index.jsonl", linux_home.trim_end_matches('/'));
    wsl_command_text(&wsl_exe, &["-d", distro, "--exec", "cat", &index])
        .ok()
        .map(|(stdout, _)| stdout)
}

// 校验 WSL 索引中的绝对会话目录并生成主日志 UNC 路径。
fn wire_path_from_wsl_session_index(
    linux_home: &str,
    distro: &str,
    session_id: &str,
) -> Option<PathBuf> {
    let stdout = read_wsl_kimi_session_index(linux_home, distro)?;
    let value = latest_kimi_index_record(&stdout, session_id)?;
    let session_dir = value
        .get("sessionDir")
        .or_else(|| value.get("session_dir"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if !session_dir.replace('\\', "/").starts_with('/') {
        return None;
    }
    let dir = resolve_linux_session_dir(linux_home, session_dir);
    let linux_sessions = format!("{}/sessions", linux_home.trim_end_matches('/'));
    if !linux_path_within_home(&dir, &linux_sessions)
        || dir
            .replace('\\', "/")
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            != Some(session_id)
    {
        return None;
    }
    let wire = format!("{}/agents/main/wire.jsonl", dir.trim_end_matches('/'));
    if !looks_like_kimi_linux_main_wire(&wire) {
        return None;
    }
    Some(PathBuf::from(crate::wsl::linux_to_unc_wsl_path(
        &wire, distro,
    )))
}

// 通过 WSL find 定位指定会话的首个主代理日志。
fn wsl_find_exact_kimi_wire(linux_home: &str, distro: &str, session_id: &str) -> Option<PathBuf> {
    let wsl_exe = wsl_exe_string()?;
    let linux_sessions = format!("{}/sessions", linux_home.trim_end_matches('/'));
    let path_pattern = format!("*/{session_id}/agents/main/wire.jsonl");
    let args = [
        "-d",
        distro,
        "--exec",
        "find",
        linux_sessions.as_str(),
        "-path",
        path_pattern.as_str(),
        "-type",
        "f",
    ];
    let (stdout, _) = wsl_command_text(&wsl_exe, &args).ok()?;
    stdout
        .lines()
        .map(str::trim)
        .find(|line| looks_like_kimi_linux_main_wire(line))
        .map(|linux_path| PathBuf::from(crate::wsl::linux_to_unc_wsl_path(linux_path, distro)))
}

// 优先读取会话状态中的工作目录，否则回退会话索引。
pub(super) fn kimi_workspace_from_path(path: &Path) -> Option<String> {
    kimi_state_value(path)
        .as_ref()
        .and_then(|state| kimi_string(state, &["cwd", "workDir", "workdir"]))
        .or_else(|| kimi_index_workdir(path))
}

// 优先用规范化工作目录作为项目键，否则回退会话标识。
fn kimi_project_key_from_path(path: &Path) -> String {
    kimi_workspace_from_path(path)
        .map(|cwd| normalize_history_path(&cwd))
        .filter(|key| !key.is_empty())
        .or_else(|| kimi_session_id_from_path(path))
        .unwrap_or_else(|| "kimi".to_string())
}

// 从 Linux 主日志层级提取工作目录键，缺失时使用默认值。
fn kimi_project_key_from_linux_path(linux_path: &str) -> String {
    // .../sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl
    let normalized = linux_path.replace('\\', "/");
    normalized
        .split('/')
        .rev()
        .nth(4)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "kimi".to_string())
}

// 优先读取状态中的有效会话标识，否则使用会话目录名。
fn kimi_session_id_from_path(path: &Path) -> Option<String> {
    kimi_state_value(path)
        .as_ref()
        .and_then(kimi_session_id_from_state)
        .or_else(|| {
            kimi_session_dir_from_wire(path)
                .and_then(|dir| {
                    dir.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                })
                .map(|id| id.trim().to_string())
                .filter(|id| is_valid_kimi_session_id(id))
        })
}

// 从状态兼容字段提取并校验会话标识。
fn kimi_session_id_from_state(state: &Value) -> Option<String> {
    kimi_string(state, &["id", "sessionId", "session_id"]).filter(|id| is_valid_kimi_session_id(id))
}

// 读取主日志所属会话的 state.json 对象。
fn kimi_state_value(path: &Path) -> Option<Value> {
    let state_path = kimi_session_dir_from_wire(path)?.join("state.json");
    fs::read_to_string(state_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

// 从所属根目录的最新活动索引读取会话工作目录。
fn kimi_index_workdir(path: &Path) -> Option<String> {
    let session_id = kimi_session_dir_from_wire(path)?
        .file_name()
        .map(|name| name.to_string_lossy().to_string())?;
    let home = kimi_session_dir_from_wire(path)?
        .parent()?
        .parent()?
        .parent()?
        .to_path_buf();
    let index = home.join("session_index.jsonl");
    let raw = fs::read_to_string(index).ok()?;
    let value = latest_kimi_index_record(&raw, &session_id)?;
    kimi_string(&value, &["workDir", "workdir", "cwd"])
}

// 使用状态文件补充会话标识、标题、父会话及时间信息。
pub(super) fn apply_kimi_state_metadata(path: &Path, computed: &mut CachedSessionComputation) {
    let Some(state) = kimi_state_value(path) else {
        if computed.session_id.is_empty() || computed.session_id == "unknown-session" {
            if let Some(session_id) = kimi_session_id_from_path(path) {
                computed.session_id = session_id;
            }
        }
        return;
    };

    if let Some(session_id) = kimi_session_id_from_state(&state) {
        computed.session_id = session_id;
    } else if let Some(session_id) = kimi_session_id_from_path(path) {
        computed.session_id = session_id;
    }

    if let Some(title) = kimi_string(&state, &["title"]) {
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            computed.title = excerpt_title(trimmed);
        }
    } else if computed.title.is_empty()
        || computed.title == computed.session_id
        || computed.title.chars().count() < 4
    {
        if let Some(prompt) = kimi_string(&state, &["lastPrompt", "last_prompt"]) {
            let trimmed = prompt.trim();
            if !trimmed.is_empty() {
                computed.title = excerpt_title(trimmed);
            }
        }
    }

    if computed.parent_session_id.is_none() {
        computed.parent_session_id = kimi_string(&state, &["forkedFrom", "forked_from"]);
    }

    if let Some(created) = state
        .get("createdAt")
        .or_else(|| state.get("created_at"))
        .and_then(parse_timestamp_millis_value)
    {
        computed.created_at = created;
    }
    if let Some(updated) = state
        .get("updatedAt")
        .or_else(|| state.get("updated_at"))
        .and_then(parse_timestamp_millis_value)
    {
        computed.updated_at = updated.max(computed.created_at);
    }
}

// 将标题限制为八十个字符，截断时添加省略号。
fn excerpt_title(text: &str) -> String {
    let mut chars = text.chars();
    let excerpt: String = chars.by_ref().take(80).collect();
    if chars.next().is_some() {
        format!("{excerpt}…")
    } else {
        excerpt
    }
}

// 将 Kimi 工作目录元数据转换为项目扫描结果。
pub(super) fn scan_kimi_project(path: &Path) -> SessionProjectScan {
    SessionProjectScan {
        cwd: kimi_workspace_from_path(path),
    }
}

struct PendingKimiMessage {
    role: String,
    content: String,
    timestamp: Option<String>,
    model: Option<String>,
    line_index: usize,
    step_uuid: Option<String>,
}

struct KimiUsagePoint {
    line_index: usize,
    timestamp_ms: Option<i64>,
    model: Option<String>,
    usage: UsageTokenScan,
}

// 取出待处理消息，规范化非空内容并保留原始行索引。
fn flush_kimi_message(
    messages: &mut Vec<HistoryMessage>,
    pending: &mut Option<PendingKimiMessage>,
) {
    let Some(pending) = pending.take() else {
        return;
    };
    let content = normalize_text(&pending.content);
    if content.is_empty() {
        return;
    }
    let mut message = json_history_message(pending.role, content, pending.timestamp, pending.model);
    message.line_index = Some(pending.line_index);
    messages.push(message);
}

// 构造单条待处理消息并立即输出到结果集合。
fn push_kimi_message(
    messages: &mut Vec<HistoryMessage>,
    role: String,
    content: String,
    timestamp: Option<String>,
    model: Option<String>,
    line_index: usize,
) {
    let mut pending = Some(PendingKimiMessage {
        role,
        content,
        timestamp,
        model,
        line_index,
        step_uuid: None,
    });
    flush_kimi_message(messages, &mut pending);
}

// 解析 Kimi 主日志消息与工具统计，协调重复用量记录后生成摘要。
pub(super) fn scan_kimi_jsonl_session(
    path: &Path,
    collect_messages: bool,
) -> (
    super::SessionSummaryScan,
    SessionStatsScan,
    Vec<HistoryMessage>,
) {
    let Ok(file) = File::open(path) else {
        return empty_session_scan();
    };
    let state = kimi_state_value(path);
    let session_id = state
        .as_ref()
        .and_then(kimi_session_id_from_state)
        .or_else(|| kimi_session_id_from_path(path));
    let title = state
        .as_ref()
        .and_then(|value| kimi_string(value, &["title", "lastPrompt", "last_prompt"]));
    let parent_session_id = state
        .as_ref()
        .and_then(|value| kimi_string(value, &["forkedFrom", "forked_from"]));

    let mut messages = Vec::new();
    let mut current_model: Option<String> = None;
    let mut seen_tool_call_ids = HashSet::new();
    let mut tool_call_count = 0u64;
    let mut builtin_calls = std::collections::HashMap::new();
    let mut step_usage_points = Vec::new();
    let mut usage_record_points = Vec::new();
    let mut pending_prompt: Option<PendingKimiMessage> = None;
    let mut pending_assistant: Option<PendingKimiMessage> = None;

    for (line_index, line) in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
        .enumerate()
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let record_type = kimi_record_type(&value);
        if let Some(model) = kimi_model_from_record(&value) {
            current_model = Some(model);
        }

        match record_type.as_str() {
            "turn.prompt" | "turn.steer" | "turn_begin" | "turn.begin" => {
                flush_kimi_message(&mut messages, &mut pending_prompt);
                if let Some(text) = kimi_user_text(&value) {
                    pending_prompt = Some(PendingKimiMessage {
                        role: "user".to_string(),
                        content: text,
                        timestamp: kimi_record_timestamp(&value),
                        model: None,
                        line_index,
                        step_uuid: None,
                    });
                }
            }
            "context.append_message" | "context.append" => {
                if let Some((role, text)) = kimi_appended_message(&value) {
                    if role == "user"
                        && pending_prompt
                            .as_ref()
                            .is_some_and(|prompt| prompt.content == text)
                    {
                        pending_prompt = None;
                    } else {
                        flush_kimi_message(&mut messages, &mut pending_prompt);
                    }
                    flush_kimi_message(&mut messages, &mut pending_assistant);
                    push_kimi_message(
                        &mut messages,
                        role,
                        text,
                        kimi_record_timestamp(&value),
                        current_model.clone(),
                        line_index,
                    );
                }
            }
            "context.append_loop_event" => {
                let Some(event) = value.get("event").filter(|event| event.is_object()) else {
                    continue;
                };
                let event_type = kimi_record_type(event);
                match event_type.as_str() {
                    "step.begin" => {
                        flush_kimi_message(&mut messages, &mut pending_prompt);
                        flush_kimi_message(&mut messages, &mut pending_assistant);
                        pending_assistant = Some(PendingKimiMessage {
                            role: "assistant".to_string(),
                            content: String::new(),
                            timestamp: kimi_record_timestamp(&value),
                            model: current_model.clone(),
                            line_index,
                            step_uuid: kimi_string(event, &["uuid", "stepUuid"]),
                        });
                    }
                    "content.part" => {
                        flush_kimi_message(&mut messages, &mut pending_prompt);
                        let step_uuid = kimi_string(event, &["stepUuid", "step_uuid"]);
                        if pending_assistant.as_ref().is_some_and(|pending| {
                            pending.step_uuid.is_some()
                                && step_uuid.is_some()
                                && pending.step_uuid != step_uuid
                        }) {
                            flush_kimi_message(&mut messages, &mut pending_assistant);
                        }
                        let text = event
                            .get("part")
                            .and_then(|part| kimi_text_from_value(Some(part)))
                            .map(|text| normalize_text(&text))
                            .filter(|text| !text.is_empty());
                        if let Some(text) = text {
                            let pending =
                                pending_assistant.get_or_insert_with(|| PendingKimiMessage {
                                    role: "assistant".to_string(),
                                    content: String::new(),
                                    timestamp: kimi_record_timestamp(&value),
                                    model: current_model.clone(),
                                    line_index,
                                    step_uuid: step_uuid.clone(),
                                });
                            pending.content.push_str(&text);
                        }
                    }
                    "tool.call" => {
                        flush_kimi_message(&mut messages, &mut pending_prompt);
                        flush_kimi_message(&mut messages, &mut pending_assistant);
                        if let Some(name) = kimi_tool_name(event) {
                            let call_id = kimi_tool_call_id(event);
                            if mark_tool_event_seen(call_id.as_deref(), &mut seen_tool_call_ids) {
                                tool_call_count += 1;
                                *builtin_calls.entry(name.clone()).or_insert(0) += 1;
                            }
                            if collect_messages {
                                push_kimi_message(
                                    &mut messages,
                                    "tool".to_string(),
                                    kimi_tool_message_text(event, &name),
                                    kimi_record_timestamp(&value),
                                    None,
                                    line_index,
                                );
                            }
                        }
                    }
                    "tool.result" => {
                        flush_kimi_message(&mut messages, &mut pending_prompt);
                        flush_kimi_message(&mut messages, &mut pending_assistant);
                        if collect_messages {
                            if let Some(text) = kimi_tool_result_text(event) {
                                push_kimi_message(
                                    &mut messages,
                                    "tool".to_string(),
                                    text,
                                    kimi_record_timestamp(&value),
                                    None,
                                    line_index,
                                );
                            }
                        }
                    }
                    "step.end" => {
                        flush_kimi_message(&mut messages, &mut pending_prompt);
                        flush_kimi_message(&mut messages, &mut pending_assistant);
                        let usage = kimi_usage_tokens(event);
                        if usage_total_tokens(usage) > 0 {
                            step_usage_points.push(KimiUsagePoint {
                                line_index,
                                timestamp_ms: extract_timestamp_millis(&value),
                                model: current_model.clone(),
                                usage,
                            });
                        }
                    }
                    _ => {}
                }
            }
            "usage.record" | "usage" => {
                let usage = kimi_usage_tokens(&value);
                if usage_total_tokens(usage) == 0 {
                    continue;
                }
                let model = kimi_model_from_record(&value).or_else(|| current_model.clone());
                usage_record_points.push(KimiUsagePoint {
                    line_index,
                    timestamp_ms: extract_timestamp_millis(&value),
                    model,
                    usage,
                });
            }
            record if kimi_is_tool_record(record) => {
                flush_kimi_message(&mut messages, &mut pending_prompt);
                flush_kimi_message(&mut messages, &mut pending_assistant);
                if let Some(name) = kimi_tool_name(&value) {
                    let call_id = kimi_tool_call_id(&value);
                    if mark_tool_event_seen(call_id.as_deref(), &mut seen_tool_call_ids) {
                        tool_call_count += 1;
                        *builtin_calls.entry(name.clone()).or_insert(0) += 1;
                    }
                    if collect_messages {
                        let content = kimi_tool_message_text(&value, &name);
                        if !content.is_empty() {
                            let mut message = json_history_message(
                                "tool".to_string(),
                                content,
                                kimi_record_timestamp(&value),
                                None,
                            );
                            message.line_index = Some(line_index);
                            messages.push(message);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    flush_kimi_message(&mut messages, &mut pending_prompt);
    flush_kimi_message(&mut messages, &mut pending_assistant);

    let usage_points = reconcile_kimi_usage_points(step_usage_points, usage_record_points);
    let mut token_trend = Vec::with_capacity(usage_points.len());
    let mut usage_events = Vec::with_capacity(usage_points.len());
    let mut totals = UsageTokenScan::default();
    for point in usage_points {
        totals.input_tokens = totals.input_tokens.saturating_add(point.usage.input_tokens);
        totals.output_tokens = totals
            .output_tokens
            .saturating_add(point.usage.output_tokens);
        totals.cache_read_tokens = totals
            .cache_read_tokens
            .saturating_add(point.usage.cache_read_tokens);
        totals.cache_creation_tokens = totals
            .cache_creation_tokens
            .saturating_add(point.usage.cache_creation_tokens);
        token_trend.push(usage_trend_point(point.usage, point.model.clone()));
        let cost = calculate_usage_cost(point.model.as_deref(), point.usage);
        usage_events.push(super::SessionUsageEventScan {
            event_key: format!("kimi-usage-{}", point.line_index),
            event_index: usage_events.len(),
            timestamp_ms: point.timestamp_ms,
            model: point.model,
            usage: cost,
        });
    }

    let (mut summary_scan, mut stats, output_messages) = json_session_scan_result(
        session_id.as_deref(),
        title.as_deref(),
        messages,
        collect_messages,
    );
    summary_scan.parent_session_id = parent_session_id;
    if stats.current_model.is_none() {
        stats.current_model = current_model.clone();
        stats.dominant_model = current_model;
    }
    stats.tool_call_count = tool_call_count;
    stats.builtin_calls = builtin_calls;
    stats.usage_events = usage_events;
    for event in &stats.usage_events {
        if let Some(model_name) = event.model.as_deref() {
            let entry = stats.model_usage.entry(model_name.to_string()).or_default();
            entry.input_tokens = entry.input_tokens.saturating_add(event.usage.input_tokens);
            entry.output_tokens = entry
                .output_tokens
                .saturating_add(event.usage.output_tokens);
            entry.cache_read_tokens = entry
                .cache_read_tokens
                .saturating_add(event.usage.cache_read_tokens);
            entry.cache_creation_tokens = entry
                .cache_creation_tokens
                .saturating_add(event.usage.cache_creation_tokens);
            entry.total_cost_usd += event.usage.total_cost_usd;
            entry.unpriced_tokens = entry
                .unpriced_tokens
                .saturating_add(event.usage.unpriced_tokens);
        }
        stats.total_cost_usd += event.usage.total_cost_usd;
        stats.unpriced_tokens = stats
            .unpriced_tokens
            .saturating_add(event.usage.unpriced_tokens);
    }
    if usage_total_tokens(totals) > 0 {
        stats.input_tokens = totals.input_tokens;
        stats.output_tokens = totals.output_tokens;
        stats.cache_read_tokens = totals.cache_read_tokens;
        stats.cache_creation_tokens = totals.cache_creation_tokens;
    }
    if !token_trend.is_empty() {
        stats.token_trend = token_trend;
    }
    (summary_scan, stats, output_messages)
}

// 扫描 Kimi 工具调用及结果，按调用标识关联状态、摘要和耗时。
pub(super) fn scan_kimi_tool_events(path: &Path) -> Vec<HistoryToolEvent> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut events: Vec<HistoryToolEvent> = Vec::new();
    let mut seen_call_ids = HashSet::new();
    let mut event_by_call_id: HashMap<String, usize> = HashMap::new();
    let mut started_at_by_call_id: HashMap<String, i64> = HashMap::new();
    let mut assistant_steps = HashSet::new();
    let mut message_index = 0usize;
    for line in BufReader::with_capacity(READ_BUF_CAPACITY, file)
        .lines()
        .map_while(Result::ok)
    {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let outer_type = kimi_record_type(&value);
        if matches!(
            outer_type.as_str(),
            "context.append_message" | "context.append"
        ) {
            message_index += 1;
        }
        let event = if outer_type == "context.append_loop_event" {
            value.get("event").unwrap_or(&value)
        } else {
            &value
        };
        let event_type = kimi_record_type(event);
        if event_type == "content.part" {
            if let Some(step_uuid) = kimi_string(event, &["stepUuid", "step_uuid"]) {
                if assistant_steps.insert(step_uuid) {
                    message_index += 1;
                }
            }
            continue;
        }
        if event_type == "tool.result" {
            let Some(call_id) = kimi_tool_call_id(event) else {
                continue;
            };
            let Some(event_index) = event_by_call_id.get(&call_id).copied() else {
                continue;
            };
            let result = event.get("result").unwrap_or(event);
            events[event_index].output_summary = result
                .get("output")
                .and_then(summarize_json_value)
                .or_else(|| summarize_json_value(result));
            events[event_index].status = Some(
                if result.get("isError").and_then(Value::as_bool) == Some(true) {
                    "failed"
                } else {
                    "completed"
                }
                .to_string(),
            );
            if let (Some(started_at), Some(completed_at)) = (
                started_at_by_call_id.get(&call_id).copied(),
                extract_timestamp_millis(&value),
            ) {
                events[event_index].duration_ms = completed_at
                    .checked_sub(started_at)
                    .and_then(|duration| u64::try_from(duration).ok());
            }
            continue;
        }
        if !kimi_is_tool_record(&event_type) {
            continue;
        }
        let Some(name) = kimi_tool_name(event) else {
            continue;
        };
        let call_id = kimi_tool_call_id(event);
        if !mark_tool_event_seen(call_id.as_deref(), &mut seen_call_ids) {
            continue;
        }
        let event_index = events.len();
        events.push(make_tool_event(
            call_id.clone(),
            &name,
            Some(message_index.saturating_sub(1)),
            kimi_record_timestamp(&value),
            Some("started"),
            None,
            event
                .get("args")
                .or_else(|| event.get("arguments"))
                .or_else(|| event.get("input"))
                .and_then(summarize_json_value),
            None,
            None,
        ));
        if let Some(call_id) = call_id {
            event_by_call_id.insert(call_id.clone(), event_index);
            if let Some(started_at) = extract_timestamp_millis(&value) {
                started_at_by_call_id.insert(call_id, started_at);
            }
        }
    }
    events
}

// 使用默认备份目录执行 Kimi 会话树删除。
pub(super) fn delete_kimi_session_tree(
    file_ref: &SessionFileRef,
    home: &Path,
) -> Result<(), String> {
    let backups_dir = default_backup_root()?;
    delete_kimi_session_tree_with_backup_root(file_ref, home, &backups_dir)
}

// 备份主日志、状态和索引后追加墓碑并删除会话目录，失败时补写恢复索引。
pub(super) fn delete_kimi_session_tree_with_backup_root(
    file_ref: &SessionFileRef,
    home: &Path,
    backups_dir: &Path,
) -> Result<(), String> {
    let Some(session_dir) = kimi_session_dir_from_wire(&file_ref.path) else {
        return Err("invalid_session_file".to_string());
    };
    let canonical_home = home
        .canonicalize()
        .map_err(|_| "history_source_not_found".to_string())?;
    let canonical_session = session_dir
        .canonicalize()
        .map_err(|_| format!("Session directory not found: {}", session_dir.display()))?;
    if !path_within_history_scope(&canonical_session, &canonical_home) {
        return Err("session_file_outside_history_scope".to_string());
    }
    let session_id = canonical_session
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|id| is_valid_kimi_session_id(id))
        .ok_or_else(|| "invalid_session_file".to_string())?;

    let wire = canonical_session
        .join("agents")
        .join("main")
        .join("wire.jsonl");
    let state = canonical_session.join("state.json");
    let index = canonical_home.join("session_index.jsonl");
    for path in [&wire, &state] {
        if path.exists() {
            create_file_backup_snapshot(path, &backups_dir, "kimi", &session_id, "sessionDelete")?;
        }
    }
    let _index_backup = if index.exists() {
        Some(create_file_backup_snapshot(
            &index,
            &backups_dir,
            "kimi",
            &session_id,
            "sessionIndexDelete",
        )?)
    } else {
        None
    };

    let restore_record = fs::read_to_string(&index)
        .ok()
        .and_then(|raw| latest_kimi_index_record(&raw, &session_id))
        .unwrap_or_else(|| {
            json!({
                "sessionId": session_id,
                "sessionDir": canonical_session.to_string_lossy(),
                "workDir": kimi_workspace_from_path(&wire).unwrap_or_default()
            })
        });
    append_session_index_record(&index, &json!({ "sessionId": session_id, "deleted": true }))?;
    match fs::remove_dir_all(&canonical_session) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => {
            if let Err(restore_err) = append_session_index_record(&index, &restore_record) {
                return Err(format!(
                    "failedRolledBack: {err}; index_restore_failed: {restore_err}"
                ));
            }
            Err(format!("failedRolledBack: {err}"))
        }
    }
}

// 追加单条 Kimi 索引记录，并在旧尾部缺少换行时补齐分隔。
fn append_session_index_record(index: &Path, record: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(record).map_err(|err| err.to_string())?;
    line.push(b'\n');
    if fs::read(index)
        .ok()
        .and_then(|raw| raw.last().copied())
        .is_some_and(|last| last != b'\n')
    {
        line.insert(0, b'\n');
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(index)
        .map_err(|err| err.to_string())?;
    file.write_all(&line).map_err(|err| err.to_string())
}

// 从兼容字段中取首个非空记录类型。
fn kimi_record_type(value: &Value) -> String {
    ["type", "kind", "event", "name"]
        .into_iter()
        .filter_map(|key| value.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

// 按类型名识别工具调用或开始事件，排除用量记录。
fn kimi_is_tool_record(record_type: &str) -> bool {
    let lower = record_type.to_ascii_lowercase();
    lower.contains("tool")
        && !lower.contains("usage")
        && (lower.contains("call")
            || lower.contains("start")
            || lower.contains("use")
            || lower == "tool")
}

// 从兼容输入字段提取并规范化非空用户文本。
fn kimi_user_text(value: &Value) -> Option<String> {
    kimi_text_from_value(value.get("input"))
        .or_else(|| kimi_text_from_value(value.get("userInput")))
        .or_else(|| kimi_text_from_value(value.get("user_input")))
        .or_else(|| kimi_text_from_value(value.get("content")))
        .or_else(|| {
            value
                .get("userInput")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .map(|text| normalize_text(&text))
        .filter(|text| !text.is_empty())
}

// 解析追加消息的角色与内容，缺失角色时使用助手。
fn kimi_appended_message(value: &Value) -> Option<(String, String)> {
    let message = value.get("message").unwrap_or(value);
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|role| !role.is_empty())
        .unwrap_or("assistant");
    let normalized = if role.contains("user") || role.contains("human") {
        "user"
    } else if role.contains("tool") {
        "tool"
    } else if role.contains("system") {
        "system"
    } else {
        "assistant"
    };
    let text = kimi_text_from_value(message.get("content"))
        .or_else(|| kimi_text_from_value(value.get("content")))
        .map(|text| normalize_text(&text))
        .filter(|text| !text.is_empty())?;
    Some((normalized.to_string(), text))
}

// 从字符串、片段数组或通用 JSON 内容提取文本。
fn kimi_text_from_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return Some(text.to_string());
    }
    if let Some(parts) = value.as_array() {
        let mut chunks = Vec::new();
        for part in parts {
            if let Some(text) = part
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                chunks.push(text.to_string());
            } else if let Some(text) = extract_text_from_value(part)
                .map(|text| normalize_text(&text))
                .filter(|text| !text.is_empty())
            {
                chunks.push(text);
            }
        }
        let joined = chunks.join("");
        return (!joined.is_empty()).then_some(joined);
    }
    extract_text_from_value(value)
}

// 从记录、配置或配置档字段中提取模型标识。
fn kimi_model_from_record(value: &Value) -> Option<String> {
    kimi_string(
        value,
        &[
            "model",
            "modelId",
            "model_id",
            "modelAlias",
            "model_alias",
            "current_model",
            "currentModel",
        ],
    )
    .or_else(|| {
        value
            .get("config")
            .and_then(|config| kimi_string(config, &["model", "modelId"]))
    })
    .or_else(|| {
        value
            .get("profile")
            .and_then(|profile| kimi_string(profile, &["model", "modelId"]))
    })
}

// 从直接字段及嵌套工具或函数对象提取工具名称。
fn kimi_tool_name(value: &Value) -> Option<String> {
    kimi_string(value, &["name", "toolName", "tool_name", "tool"])
        .or_else(|| {
            value
                .get("tool")
                .and_then(|tool| kimi_string(tool, &["name", "id"]))
        })
        .or_else(|| {
            value
                .get("function")
                .and_then(|function| kimi_string(function, &["name"]))
        })
}

// 从兼容字段提取工具调用标识。
fn kimi_tool_call_id(value: &Value) -> Option<String> {
    kimi_string(
        value,
        &["id", "callId", "call_id", "toolCallId", "tool_call_id"],
    )
}

// 组合工具名称与输入文本或 JSON 摘要。
fn kimi_tool_message_text(value: &Value, name: &str) -> String {
    kimi_text_from_value(value.get("input"))
        .or_else(|| kimi_text_from_value(value.get("arguments")))
        .or_else(|| kimi_text_from_value(value.get("args")))
        .or_else(|| kimi_text_from_value(value.get("content")))
        .or_else(|| {
            value
                .get("args")
                .or_else(|| value.get("arguments"))
                .or_else(|| value.get("input"))
                .and_then(summarize_json_value)
        })
        .map(|summary| format!("{name}: {summary}"))
        .unwrap_or_else(|| name.to_string())
}

// 优先提取工具输出文本，否则生成结果 JSON 摘要。
fn kimi_tool_result_text(value: &Value) -> Option<String> {
    let result = value.get("result").unwrap_or(value);
    result
        .get("output")
        .and_then(|output| kimi_text_from_value(Some(output)))
        .or_else(|| result.get("output").and_then(summarize_json_value))
        .or_else(|| summarize_json_value(result))
}

// 读取通用用量并用 Kimi 专有输入和缓存字段覆盖。
fn kimi_usage_tokens(value: &Value) -> UsageTokenScan {
    let mut usage = extract_usage_tokens(value);
    let payload = value.get("usage").unwrap_or(value);
    if let Some(input) = kimi_u64(payload, &["inputOther", "input_other"]) {
        usage.input_tokens = input;
    }
    if let Some(output) = kimi_u64(payload, &["output"]) {
        usage.output_tokens = output;
    }
    if let Some(cache_read) = kimi_u64(payload, &["inputCacheRead", "input_cache_read"]) {
        usage.cache_read_tokens = cache_read;
    }
    if let Some(cache_creation) = kimi_u64(payload, &["inputCacheCreation", "input_cache_creation"])
    {
        usage.cache_creation_tokens = cache_creation;
    }
    usage
}

// 比较两条用量的输入、输出及两类缓存计数。
fn same_kimi_usage(left: UsageTokenScan, right: UsageTokenScan) -> bool {
    left.input_tokens == right.input_tokens
        && left.output_tokens == right.output_tokens
        && left.cache_read_tokens == right.cache_read_tokens
        && left.cache_creation_tokens == right.cache_creation_tokens
}

// 将相同用量记录匹配到最近未配对步骤，补充模型并保留独立用量。
fn reconcile_kimi_usage_points(
    mut step_points: Vec<KimiUsagePoint>,
    record_points: Vec<KimiUsagePoint>,
) -> Vec<KimiUsagePoint> {
    let original_step_count = step_points.len();
    let mut matched_steps = vec![false; original_step_count];
    for record in record_points {
        let matching_step = (0..original_step_count)
            .filter(|index| {
                !matched_steps[*index] && same_kimi_usage(step_points[*index].usage, record.usage)
            })
            .min_by_key(|index| step_points[*index].line_index.abs_diff(record.line_index));
        if let Some(index) = matching_step {
            matched_steps[index] = true;
            if record.model.is_some() {
                step_points[index].model = record.model;
            }
        } else {
            step_points.push(record);
        }
    }
    step_points.sort_by_key(|point| point.line_index);
    step_points
}

// 按候选字段读取无符号数值或可解析的数字字符串。
fn kimi_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    let map = value.as_object()?;
    keys.iter().find_map(|key| match map.get(*key) {
        Some(Value::Number(value)) => value.as_u64(),
        Some(Value::String(value)) => value.trim().parse::<u64>().ok(),
        _ => None,
    })
}

// 将记录时间转换为 RFC3339 字符串。
fn kimi_record_timestamp(value: &Value) -> Option<String> {
    extract_timestamp_millis(value).and_then(timestamp_millis_to_rfc3339)
}

// 按候选字段返回首个去空白后的非空字符串。
fn kimi_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 验证 Linux 主日志路径识别拒绝子代理及嵌套代理层级。
    fn linux_main_wire_accepts_session_layout_and_rejects_nested_agent() {
        assert!(looks_like_kimi_linux_main_wire(
            "/home/u/.kimi-code/sessions/wd/01ABC/agents/main/wire.jsonl"
        ));
        assert!(!looks_like_kimi_linux_main_wire(
            "/home/u/.kimi-code/sessions/wd/01ABC/agents/agent-0/agents/main/wire.jsonl"
        ));
        assert!(!looks_like_kimi_linux_main_wire(
            "/home/u/.kimi-code/sessions/wd/01ABC/agents/agent-0/wire.jsonl"
        ));
    }

    #[test]
    // 验证 Linux 目录范围检查拒绝父目录逃逸。
    fn linux_path_within_home_rejects_parent_escape() {
        assert!(!linux_path_within_home(
            "/home/u/.kimi-code/../outside",
            "/home/u/.kimi-code"
        ));
        assert!(linux_path_within_home(
            "/home/u/.kimi-code/sessions/wd/01ABC",
            "/home/u/.kimi-code"
        ));
    }

    #[test]
    // 验证最新有效活动索引覆盖旧记录，墓碑清除活动结果。
    fn session_index_uses_latest_record_and_honors_tombstones() {
        let session_id = "01KIMILATEST000000000001";
        let active_after_tombstone = format!(
            "{}\n{}\n{}\n{}\n",
            json!({"sessionId": session_id, "sessionDir": "/old", "workDir": "/old"}),
            json!({"sessionId": session_id, "deleted": true}),
            json!({"sessionId": session_id, "sessionDir": "/new", "workDir": "/new"}),
            json!({"sessionId": session_id, "sessionDir": "/malformed"})
        );
        let latest = latest_kimi_index_record(&active_after_tombstone, session_id).unwrap();
        assert_eq!(latest.get("workDir").and_then(Value::as_str), Some("/new"));

        let deleted = format!(
            "{active_after_tombstone}{}\n",
            json!({"sessionId": session_id, "deleted": true})
        );
        assert!(latest_kimi_index_record(&deleted, session_id).is_none());
    }

    #[test]
    // 验证状态中的会话标识拒绝 shell 元字符。
    fn state_session_id_rejects_shell_metacharacters() {
        assert_eq!(
            kimi_session_id_from_state(&json!({"id": "01KIMI_SAFE-id"})).as_deref(),
            Some("01KIMI_SAFE-id")
        );
        assert!(kimi_session_id_from_state(&json!({"id": "01KIMI&calc"})).is_none());
    }

    #[test]
    // 验证索引追加会先分隔没有换行的旧尾部。
    fn index_append_separates_a_partial_tail() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        let index = temp_dir.path().join("session_index.jsonl");
        fs::write(&index, b"{\"partial\":true}").unwrap();
        append_session_index_record(
            &index,
            &json!({"sessionId": "01KIMIAPPENDSAFE", "deleted": true}),
        )
        .unwrap();
        let raw = fs::read_to_string(index).unwrap();
        let appended: Value = serde_json::from_str(raw.lines().last().unwrap()).unwrap();
        assert_eq!(appended.get("deleted").and_then(Value::as_bool), Some(true));
    }
}
