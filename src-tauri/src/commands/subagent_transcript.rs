//! 子 Agent 转录 tail 桥接：订阅一个子 Agent 的转录 jsonl 文件，按行增量向前端推送。
//!
//! 设计取舍：转录文件是短生命周期、append-only 的小文件，且在 SubagentStart 触发时
//! 可能尚未创建。相比 fs-watcher，每订阅一个轻量轮询线程在「文件还不存在 / 被截断 / 跨平台」
//! 上更稳。仅按 `\n` 边界发送完整行，残行留到下次轮询，避免把 jsonl 行/UTF-8 截断。
//!
//! 路径定位：优先用 hook 负载里的 `agentTranscriptPath`；否则由 `cwd + 父 sessionId + agentId`
//! 推导 `<home>/.claude/projects/<slug(cwd)>/<sessionId>/subagents/agent-<agentId>.jsonl`。
//! WSL 下 Claude 上报 Linux 路径时，先转为 `\\wsl.localhost\<distro>\...` 供 Windows
//! 端 tail；目录发现走 `wsl.exe find`，绕过 Plan 9 目录枚举限制。

use crate::shell_resolver::silent_command;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use log::{info, warn};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

const EVENT_NAME: &str = "subagent-transcript-append";
const POLL_MS: u64 = 250;
const OOM_TRANSCRIPT_APPEND_WARN_BYTES: usize = 1024 * 1024;
const OOM_TRANSCRIPT_OFFSET_WARN_BYTES: u64 = 10 * 1024 * 1024;
const TRANSCRIPT_READ_MAX_BYTES: u64 = 1024 * 1024;

fn log_transcript_oom_diagnostic(
    phase: &str,
    key: &str,
    path: &str,
    append_bytes: usize,
    offset: u64,
    reset: bool,
) {
    let threshold_exceeded = append_bytes >= OOM_TRANSCRIPT_APPEND_WARN_BYTES
        || offset >= OOM_TRANSCRIPT_OFFSET_WARN_BYTES;
    if threshold_exceeded {
        warn!(
            "[oom-diagnostics:backend] area=subagent_transcript phase={phase} key={} path={} append_bytes={} offset={} reset={} threshold_exceeded=true",
            key,
            path,
            append_bytes,
            offset,
            reset
        );
    } else {
        info!(
            "[oom-diagnostics:backend] area=subagent_transcript phase={phase} key={} path={} append_bytes={} offset={} reset={} threshold_exceeded=false",
            key,
            path,
            append_bytes,
            offset,
            reset
        );
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppendPayload {
    /// 订阅键（由前端给定，通常是 agentId），用于把增量路由到对应转录 pane。
    key: String,
    /// 本次新增的完整行（含末尾换行）。
    content: String,
    /// true 表示首次推送或文件被截断，前端应「替换」而非「追加」。
    reset: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeResult {
    pub path: String,
    pub initial_content: String,
}

/// 持有每个订阅的停止开关（drop/置位即让对应轮询线程退出）。
#[derive(Default)]
pub struct SubagentTranscriptBridge {
    entries: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SubagentTranscriptBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// 订阅一个转录文件并开始 tail。替换同 key 的旧订阅。路径为空返回错误。
    pub fn subscribe(
        &self,
        app_handle: AppHandle,
        key: String,
        path: String,
    ) -> Result<SubscribeResult, String> {
        if path.trim().is_empty() {
            return Err("empty_transcript_path".to_string());
        }
        // 先停掉同 key 旧订阅，避免重复线程。
        self.unsubscribe(&key);

        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self
                .entries
                .lock()
                .map_err(|_| "lock_poisoned".to_string())?;
            guard.insert(key.clone(), stop.clone());
        }

        let path_buf = PathBuf::from(&path);
        let (initial_content, initial_offset) = read_new_lines(&path_buf, 0)
            .map(|(content, offset, _)| (content, offset))
            .unwrap_or_else(|| (String::new(), 0));
        let has_initial_content = initial_offset > 0;
        log_transcript_oom_diagnostic(
            "subscribe_initial",
            &key,
            &path,
            initial_content.len(),
            initial_offset,
            true,
        );
        let thread_key = key.clone();
        let thread_path = path.clone();
        thread::spawn(move || {
            tail_loop(
                app_handle,
                thread_key,
                thread_path,
                initial_offset,
                has_initial_content,
                stop,
            )
        });
        info!("[subagent_transcript] subscribe: key={key} path={path}");
        Ok(SubscribeResult {
            path,
            initial_content,
        })
    }

    /// 停止并移除指定订阅。
    pub fn unsubscribe(&self, key: &str) {
        if let Ok(mut guard) = self.entries.lock() {
            if let Some(stop) = guard.remove(key) {
                stop.store(true, Ordering::Relaxed);
                info!("[subagent_transcript] unsubscribe: {key}");
            }
        }
    }
}

/// 轮询循环：每 POLL_MS 读取自上次 offset 起的新完整行并推送，直到 stop 置位。
fn tail_loop(
    app_handle: AppHandle,
    key: String,
    path: String,
    initial_offset: u64,
    initial_started: bool,
    stop: Arc<AtomicBool>,
) {
    let path = PathBuf::from(path);
    let mut offset = initial_offset;
    let mut started = initial_started;
    let mut missing_logged = false;
    info!(
        "[subagent_transcript] tail started: key={key} path={}",
        path.to_string_lossy()
    );

    while !stop.load(Ordering::Relaxed) {
        if !missing_logged && !path.exists() {
            missing_logged = true;
            warn!(
                "[subagent_transcript] tail waiting for file: key={key} path={}",
                path.to_string_lossy()
            );
        }
        if let Some((content, new_offset, shrank)) = read_new_lines(&path, offset) {
            let reset = shrank || !started;
            started = true;
            offset = new_offset;
            if content.is_empty() {
                continue;
            }
            info!(
                "[subagent_transcript] tail read lines: key={key} bytes={} offset={} reset={reset}",
                content.len(),
                offset
            );
            log_transcript_oom_diagnostic(
                "tail_append",
                &key,
                path.to_string_lossy().as_ref(),
                content.len(),
                offset,
                reset,
            );
            let payload = AppendPayload {
                key: key.clone(),
                content,
                reset,
            };
            let _ = app_handle.emit(EVENT_NAME, payload);
        }
        thread::sleep(Duration::from_millis(POLL_MS));
    }
}

/// 从 `offset` 起读取新内容，仅返回到最后一个换行为止的完整行。
/// 返回 `(完整行内容, 新 offset, 是否因文件变短而重置)`；无新完整行时返回 None。
fn read_new_lines(path: &Path, offset: u64) -> Option<(String, u64, bool)> {
    let len = fs::metadata(path).ok()?.len();
    let (mut start, shrank) = if len < offset {
        (0u64, true)
    } else {
        (offset, false)
    };
    if len <= start {
        return None;
    }
    let tailing_initial = start == 0 && len > TRANSCRIPT_READ_MAX_BYTES;
    if tailing_initial {
        start = len.saturating_sub(TRANSCRIPT_READ_MAX_BYTES);
    }

    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    let read_len = (len - start).min(TRANSCRIPT_READ_MAX_BYTES);
    file.take(read_len).read_to_end(&mut buf).ok()?;

    // 只发送到最后一个换行；残行留到下次（换行是 ASCII，切点同时是 UTF-8 边界）。
    let last_nl = match buf.iter().rposition(|&b| b == b'\n') {
        Some(index) => index,
        None if read_len == TRANSCRIPT_READ_MAX_BYTES => {
            return Some((String::new(), start + read_len, shrank));
        }
        None => return None,
    };
    let first = if tailing_initial {
        match buf[..=last_nl].iter().position(|&b| b == b'\n') {
            Some(index) if index < last_nl => index + 1,
            _ => return Some((String::new(), start + last_nl as u64 + 1, shrank)),
        }
    } else {
        0
    };
    let complete = &buf[first..=last_nl];
    let consumed = start + last_nl as u64 + 1;
    Some((
        String::from_utf8_lossy(complete).to_string(),
        consumed,
        shrank,
    ))
}

/// cwd → Claude projects 目录 slug：把 `:`、`\`、`/` 全部替换为 `-`，其余保留。
/// 例：`D:\work\pythonProject\CLI-Manager` → `D--work-pythonProject-CLI-Manager`。
fn slug_for_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| {
            if matches!(c, ':' | '\\' | '/') {
                '-'
            } else {
                c
            }
        })
        .collect()
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn trimmed_str(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn is_linux_absolute_path(path: &str) -> bool {
    path.trim().starts_with('/')
}

fn normalize_explicit_transcript_path(path: String, wsl_distro_name: Option<&str>) -> String {
    let path = path.trim().to_string();
    if is_linux_absolute_path(&path) {
        if let Some(distro) = wsl_distro_name.map(str::trim).filter(|v| !v.is_empty()) {
            let unc = crate::wsl::linux_to_unc_wsl_path(&path, distro);
            info!(
                "[subagent_transcript] explicit linux path resolved via WSL: distro={distro} linux={path} unc={unc}"
            );
            return unc;
        }
        warn!(
            "[subagent_transcript] explicit linux path without WSL distro, using raw path: {path}"
        );
    }
    path
}

fn normalize_wsl_scope_unc(path: &str) -> String {
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

fn has_current_or_parent_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            std::path::Component::CurDir | std::path::Component::ParentDir
        )
    })
}

fn components_contain_sequence(components: &[String], sequence: &[&str]) -> bool {
    components
        .windows(sequence.len())
        .any(|window| window.iter().zip(sequence).all(|(a, b)| a == b))
}

fn is_native_transcript_scope(path: &Path) -> Result<bool, String> {
    let home = home_dir().ok_or_else(|| "no_home_dir".to_string())?;
    let allowed_roots = [home.join(".claude"), resolve_codex_sessions_root(None)];
    Ok(allowed_roots.iter().any(|root| path.starts_with(root)))
}

fn is_linux_transcript_scope(linux_path: &str) -> bool {
    let linux_path = linux_path.trim();
    if !linux_path.starts_with('/') {
        return false;
    }
    let components: Vec<String> = linux_path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    if components
        .iter()
        .any(|component| component == "." || component == "..")
    {
        return false;
    }
    components_contain_sequence(&components, &[".claude", "projects"])
        || components_contain_sequence(&components, &[".codex", "sessions"])
}

fn validate_explicit_transcript_path(path: &str) -> Result<(), String> {
    let normalized_wsl = normalize_wsl_scope_unc(path);
    if let Some((_distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&normalized_wsl) {
        if is_linux_transcript_scope(&linux_path) {
            return Ok(());
        }
        return Err("transcript_path_outside_allowed_roots".to_string());
    }

    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("transcript_path_not_absolute".to_string());
    }
    if has_current_or_parent_component(&path) {
        return Err("transcript_path_contains_parent_segment".to_string());
    }
    if is_native_transcript_scope(&path)? {
        Ok(())
    } else {
        Err("transcript_path_outside_allowed_roots".to_string())
    }
}

fn cwd_for_wsl_slug(cwd: &str) -> String {
    if is_linux_absolute_path(cwd) {
        return cwd.trim().to_string();
    }
    if let Some((_distro, linux_path)) = crate::wsl::parse_wsl_unc_path(cwd) {
        return linux_path;
    }
    crate::wsl::windows_path_to_wsl(cwd).unwrap_or_else(|| cwd.trim().to_string())
}

/// 由 home + cwd + 父 sessionId + agentId 推导子 Agent 转录 jsonl 路径。
fn derive_transcript_path(home: &Path, cwd: &str, session_id: &str, agent_id: &str) -> String {
    home.join(".claude")
        .join("projects")
        .join(slug_for_cwd(cwd))
        .join(session_id)
        .join("subagents")
        .join(format!("agent-{agent_id}.jsonl"))
        .to_string_lossy()
        .to_string()
}

fn derive_wsl_linux_transcript_path(
    linux_home: &str,
    cwd: &str,
    session_id: &str,
    agent_id: &str,
) -> String {
    let home = linux_home.trim().trim_end_matches('/');
    let cwd = cwd_for_wsl_slug(cwd);
    format!(
        "{home}/.claude/projects/{}/{session_id}/subagents/agent-{agent_id}.jsonl",
        slug_for_cwd(&cwd)
    )
}

fn derive_wsl_unc_transcript_path(
    linux_home: &str,
    cwd: &str,
    session_id: &str,
    agent_id: &str,
    distro: &str,
) -> String {
    let linux_path = derive_wsl_linux_transcript_path(linux_home, cwd, session_id, agent_id);
    crate::wsl::linux_to_unc_wsl_path(&linux_path, distro)
}

fn wsl_exe() -> String {
    crate::wsl::find_wsl_exe()
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string())
}

fn wsl_command_text(distro: &str, args: &[&str]) -> Result<(String, String), String> {
    let program = wsl_exe();
    let mut cmd = silent_command(&program);
    cmd.args(["-d", distro]);
    cmd.args(args);
    run_wsl_command(cmd, &program)
}

fn run_wsl_command(
    mut cmd: std::process::Command,
    program: &str,
) -> Result<(String, String), String> {
    let output = cmd
        .output()
        .map_err(|err| format!("wsl command '{program}' failed: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "wsl command failed (exit {}): {}",
            output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".to_string()),
            stderr.trim()
        ));
    }
    Ok((stdout, stderr))
}

fn wsl_home_dir(distro: &str) -> Result<String, String> {
    info!("[subagent_transcript:wsl] resolving HOME: distro={distro}");
    let (stdout, _stderr) = wsl_command_text(distro, &["sh", "-lc", "printf %s \"$HOME\""])?;
    let home = stdout.trim();
    if home.is_empty() {
        return Err("empty_wsl_home".to_string());
    }
    Ok(home.to_string())
}

fn resolve_wsl_transcript_path(
    cwd: String,
    session_id: String,
    agent_id: String,
    distro: String,
) -> Result<String, String> {
    let linux_home = wsl_home_dir(&distro)?;
    let resolved =
        derive_wsl_unc_transcript_path(&linux_home, &cwd, &session_id, &agent_id, &distro);
    info!(
        "[subagent_transcript:wsl] derived transcript path: distro={distro} cwd={cwd} sessionId={session_id} agentId={agent_id} path={resolved}"
    );
    Ok(resolved)
}

fn resolve_wsl_distro_name(cwd: Option<&str>, wsl_distro_name: Option<String>) -> Option<String> {
    if let Some(distro) = trimmed(wsl_distro_name) {
        return Some(distro);
    }
    cwd.and_then(crate::wsl::parse_wsl_unc_path)
        .map(|(distro, _)| distro)
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
    }
}

fn resolve_codex_sessions_root(codex_config_dir: Option<String>) -> PathBuf {
    let base = trimmed(codex_config_dir)
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("CODEX_HOME")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| home_dir().map(|home| home.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"));
    base.join("sessions")
}

fn resolve_wsl_codex_config_root(
    codex_config_dir: Option<String>,
    distro: &str,
    linux_home: &str,
) -> Result<String, String> {
    let Some(config_dir) = trimmed(codex_config_dir) else {
        return Ok(format!("{}/.codex", linux_home.trim_end_matches('/')));
    };
    if is_linux_absolute_path(&config_dir) {
        return Ok(config_dir.trim_end_matches('/').to_string());
    }
    if let Some((_configured_distro, linux_path)) =
        crate::wsl::parse_wsl_unc_path(&normalize_wsl_scope_unc(&config_dir))
    {
        return Ok(linux_path.trim_end_matches('/').to_string());
    }
    if let Some(linux_path) = crate::wsl::windows_path_to_wsl(&config_dir) {
        return Ok(linux_path.trim_end_matches('/').to_string());
    }
    Err(format!(
        "invalid_wsl_codex_config_dir: distro={distro} path={config_dir}"
    ))
}

fn resolve_wsl_codex_sessions_root(
    codex_config_dir: Option<String>,
    parent_transcript_path: Option<String>,
    distro: &str,
) -> Result<PathBuf, String> {
    if codex_config_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        if let Some(path) = trimmed(parent_transcript_path) {
            let linux_path = if is_linux_absolute_path(&path) {
                Some(path)
            } else {
                crate::wsl::parse_wsl_unc_path(&normalize_wsl_scope_unc(&path))
                    .map(|(_path_distro, linux_path)| linux_path)
            };
            if let Some(linux_path) = linux_path {
                let normalized = linux_path.replace('\\', "/");
                if let Some(index) = normalized.find("/sessions/") {
                    let sessions_root = &normalized[..index + "/sessions".len()];
                    return Ok(PathBuf::from(crate::wsl::linux_to_unc_wsl_path(
                        sessions_root,
                        distro,
                    )));
                }
            }
        }
    }
    let linux_home = wsl_home_dir(distro)?;
    let config_root = resolve_wsl_codex_config_root(codex_config_dir, distro, &linux_home)?;
    let linux_sessions_root = format!("{}/sessions", config_root.trim_end_matches('/'));
    Ok(PathBuf::from(crate::wsl::linux_to_unc_wsl_path(
        &linux_sessions_root,
        distro,
    )))
}

fn list_native_codex_rollout_candidates(root: &Path, agent_id: &str) -> Vec<PathBuf> {
    let expected_suffix = format!("-{agent_id}.jsonl");
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut scanned_dirs = 0usize;
    let mut scanned_files = 0usize;

    while let Some(dir) = stack.pop() {
        scanned_dirs += 1;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) => {
                warn!(
                    "[subagent_transcript:codex] native scan read_dir failed: dir={} agentId={} error={err}",
                    dir.to_string_lossy(),
                    agent_id
                );
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            scanned_files += 1;
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name.starts_with("rollout-") && name.ends_with(&expected_suffix) {
                out.push(path);
            }
        }
    }

    info!(
        "[subagent_transcript:codex] native scan result: root={} agentId={} suffix={} dirs={} files={} matched={}",
        root.to_string_lossy(),
        agent_id,
        expected_suffix,
        scanned_dirs,
        scanned_files,
        out.len()
    );
    out
}

fn list_wsl_codex_rollout_candidates(root: &Path, agent_id: &str) -> Vec<PathBuf> {
    let root_str = root.to_string_lossy().to_string();
    let Some((distro, linux_root)) = crate::wsl::parse_wsl_unc_path(&root_str) else {
        return Vec::new();
    };
    let pattern = format!("rollout-*-{agent_id}.jsonl");
    let args = [
        "find",
        linux_root.as_str(),
        "-type",
        "f",
        "-name",
        pattern.as_str(),
        "-printf",
        "%p\n",
    ];
    info!(
        "[subagent_transcript:codex] wsl scan start: root={} distro={} linuxRoot={} pattern={}",
        root_str, distro, linux_root, pattern
    );
    match wsl_command_text(&distro, &args) {
        Ok((stdout, stderr)) => {
            if !stderr.trim().is_empty() {
                warn!(
                    "[subagent_transcript:codex] wsl discover stderr: {}",
                    stderr.trim()
                );
            }
            let candidates: Vec<PathBuf> = stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(|line| PathBuf::from(crate::wsl::linux_to_unc_wsl_path(line, &distro)))
                .collect();
            info!(
                "[subagent_transcript:codex] wsl scan result: root={} agentId={} count={} files={:?}",
                root_str,
                agent_id,
                candidates.len(),
                candidates
                    .iter()
                    .take(20)
                    .map(|path| path.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
            );
            candidates
        }
        Err(err) => {
            warn!(
                "[subagent_transcript:codex] wsl discover failed: root={} agentId={} error={err}",
                root_str, agent_id
            );
            Vec::new()
        }
    }
}

fn list_codex_rollout_candidates(root: &Path, agent_id: &str) -> Vec<PathBuf> {
    let root_str = root.to_string_lossy().to_string();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        info!(
            "[subagent_transcript:codex] rollout scan mode=wsl root={} agentId={}",
            root_str, agent_id
        );
        return list_wsl_codex_rollout_candidates(root, agent_id);
    }
    info!(
        "[subagent_transcript:codex] rollout scan mode=native root={} agentId={}",
        root_str, agent_id
    );
    list_native_codex_rollout_candidates(root, agent_id)
}

fn codex_rollout_parent_thread_id(path: &Path) -> Option<String> {
    let path_text = path.to_string_lossy();
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) => {
            warn!(
                "[subagent_transcript:codex] inspect rollout open failed: path={} error={err}",
                path_text
            );
            return None;
        }
    };
    let mut reader = std::io::BufReader::new(file);
    let mut first_line = String::new();
    use std::io::BufRead;
    if let Err(err) = reader.read_line(&mut first_line) {
        warn!(
            "[subagent_transcript:codex] inspect rollout read first line failed: path={} error={err}",
            path_text
        );
        return None;
    }
    let trimmed = first_line.trim();
    if trimmed.is_empty() {
        warn!(
            "[subagent_transcript:codex] inspect rollout empty first line: path={}",
            path_text
        );
        return None;
    }
    let json: Value = match serde_json::from_str(trimmed) {
        Ok(json) => json,
        Err(err) => {
            warn!(
                "[subagent_transcript:codex] inspect rollout parse failed: path={} firstLineBytes={} error={err}",
                path_text,
                trimmed.len()
            );
            return None;
        }
    };
    let event_type = json.get("type").and_then(Value::as_str);
    if event_type != Some("session_meta") {
        info!(
            "[subagent_transcript:codex] inspect rollout first line is not session_meta: path={} type={:?}",
            path_text, event_type
        );
        return None;
    }
    let Some(payload) = json.get("payload") else {
        warn!(
            "[subagent_transcript:codex] inspect rollout missing payload: path={}",
            path_text
        );
        return None;
    };
    let parent_thread_id = trimmed_str(payload.get("parent_thread_id").and_then(Value::as_str));
    info!(
        "[subagent_transcript:codex] inspect rollout session_meta: path={} payloadId={:?} parentThreadId={:?} threadId={:?}",
        path_text,
        payload.get("id").and_then(Value::as_str),
        parent_thread_id,
        payload.get("thread_id").and_then(Value::as_str)
    );
    parent_thread_id
}

/// 解析转录路径：优先显式 `agentTranscriptPath`，否则由 cwd+sessionId+agentId 推导。
fn resolve_transcript_path(
    transcript_path: Option<String>,
    cwd: Option<String>,
    session_id: Option<String>,
    agent_id: Option<String>,
    wsl_distro_name: Option<String>,
) -> Result<String, String> {
    if let Some(explicit) = trimmed(transcript_path) {
        if is_linux_absolute_path(&explicit) {
            if let Some(distro) = trimmed(wsl_distro_name) {
                info!(
                    "[subagent_transcript] resolving explicit linux transcript path with distro={distro}"
                );
                let resolved = normalize_explicit_transcript_path(explicit, Some(&distro));
                validate_explicit_transcript_path(&resolved)?;
                return Ok(resolved);
            }
            let resolved = normalize_explicit_transcript_path(explicit, None);
            validate_explicit_transcript_path(&resolved)?;
            return Ok(resolved);
        }
        info!(
            "[subagent_transcript] resolving explicit transcript path: hasWslDistro={} isLinuxPath={}",
            wsl_distro_name.as_deref().is_some_and(|v| !v.trim().is_empty()),
            is_linux_absolute_path(&explicit)
        );
        let resolved = normalize_explicit_transcript_path(explicit, wsl_distro_name.as_deref());
        validate_explicit_transcript_path(&resolved)?;
        return Ok(resolved);
    }

    let cwd = trimmed(cwd).ok_or_else(|| "missing_cwd".to_string())?;
    let session_id = trimmed(session_id).ok_or_else(|| "missing_session_id".to_string())?;
    let agent_id = trimmed(agent_id).ok_or_else(|| "missing_agent_id".to_string())?;
    let resolved_wsl_distro = resolve_wsl_distro_name(Some(&cwd), wsl_distro_name);
    if let Some(distro) = resolved_wsl_distro {
        info!(
            "[subagent_transcript] resolving derived WSL transcript path: distro={distro} cwd={cwd} sessionId={session_id} agentId={agent_id}"
        );
        return resolve_wsl_transcript_path(cwd, session_id, agent_id, distro);
    }

    let home = home_dir().ok_or_else(|| "no_home_dir".to_string())?;
    info!(
        "[subagent_transcript] resolving derived native transcript path: cwd={cwd} sessionId={session_id} agentId={agent_id}"
    );
    Ok(derive_transcript_path(&home, &cwd, &session_id, &agent_id))
}

/// 订阅子 Agent 转录并开始 tail；返回最终解析到的文件路径（供前端展示/调试）。
#[tauri::command]
pub async fn subagent_transcript_subscribe(
    app_handle: AppHandle,
    bridge: State<'_, SubagentTranscriptBridge>,
    key: String,
    transcript_path: Option<String>,
    cwd: Option<String>,
    session_id: Option<String>,
    agent_id: Option<String>,
    wsl_distro_name: Option<String>,
) -> Result<SubscribeResult, String> {
    if key.trim().is_empty() {
        return Err("missing_key".to_string());
    }
    let path =
        resolve_transcript_path(transcript_path, cwd, session_id, agent_id, wsl_distro_name)?;
    info!("[subagent_transcript] subscribe resolved path: key={key} path={path}");
    bridge.subscribe(app_handle, key, path)
}

/// 取消订阅并停止 tail 线程。
#[tauri::command]
pub async fn subagent_transcript_unsubscribe(
    bridge: State<'_, SubagentTranscriptBridge>,
    key: String,
) -> Result<(), String> {
    bridge.unsubscribe(&key);
    Ok(())
}

/// 扫描 subagents 目录，返回发现的 agent-*.jsonl 文件列表（仅文件名，不含路径）。
/// 用于 AgentToolStart fallback：当 hook payload 缺少 agentId 时，前端短时轮询此命令发现新 child。
#[tauri::command]
pub async fn subagent_transcript_discover(
    cwd: String,
    session_id: String,
    wsl_distro_name: Option<String>,
) -> Result<Vec<String>, String> {
    let resolved_wsl_distro = resolve_wsl_distro_name(Some(&cwd), wsl_distro_name);
    if let Some(distro) = resolved_wsl_distro {
        info!(
            "[subagent_transcript:wsl] discover requested: distro={distro} cwd={cwd} sessionId={session_id}"
        );
        return discover_wsl_subagent_files(&cwd, &session_id, &distro);
    }

    let home = home_dir().ok_or_else(|| "no_home_dir".to_string())?;
    let subagents_dir = home
        .join(".claude")
        .join("projects")
        .join(slug_for_cwd(&cwd))
        .join(session_id)
        .join("subagents");

    if !subagents_dir.exists() {
        info!(
            "[subagent_transcript] discover native dir missing: {}",
            subagents_dir.to_string_lossy()
        );
        return Ok(Vec::new());
    }

    info!(
        "[subagent_transcript] discover native dir: {}",
        subagents_dir.to_string_lossy()
    );
    let entries = std::fs::read_dir(&subagents_dir).map_err(|e| e.to_string())?;
    let mut agent_files = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("agent-") && name.ends_with(".jsonl") {
                    agent_files.push(name.to_string());
                }
            }
        }
    }

    info!(
        "[subagent_transcript] discover native result: count={}",
        agent_files.len()
    );
    Ok(agent_files)
}

#[tauri::command]
pub async fn codex_subagent_transcript_discover(
    parent_session_id: String,
    agent_id: String,
    codex_config_dir: Option<String>,
    wsl_distro_name: Option<String>,
    parent_transcript_path: Option<String>,
) -> Result<Option<String>, String> {
    let parent_session_id = parent_session_id.trim().to_string();
    let agent_id = agent_id.trim().to_string();
    if parent_session_id.is_empty() {
        return Err("missing_parent_session_id".to_string());
    }
    if agent_id.is_empty() {
        return Err("missing_agent_id".to_string());
    }

    let resolved_wsl_distro = trimmed(wsl_distro_name);
    let sessions_root = if let Some(distro) = resolved_wsl_distro.as_deref() {
        resolve_wsl_codex_sessions_root(codex_config_dir, parent_transcript_path, distro)?
    } else {
        resolve_codex_sessions_root(codex_config_dir)
    };
    info!(
        "[subagent_transcript:codex] discover requested: root={} parentSessionId={} agentId={} wslDistro={:?}",
        sessions_root.to_string_lossy(),
        parent_session_id,
        agent_id,
        resolved_wsl_distro
    );
    if resolved_wsl_distro.is_none() && !sessions_root.exists() {
        info!(
            "[subagent_transcript:codex] sessions root missing: {}",
            sessions_root.to_string_lossy()
        );
        return Ok(None);
    }

    let candidates = list_codex_rollout_candidates(&sessions_root, &agent_id);
    info!(
        "[subagent_transcript:codex] rollout candidates: root={} agentId={} count={}",
        sessions_root.to_string_lossy(),
        agent_id,
        candidates.len()
    );
    for candidate in candidates {
        let parent_thread_id = codex_rollout_parent_thread_id(&candidate);
        info!(
            "[subagent_transcript:codex] inspect rollout candidate: agentId={} path={} parentThreadId={:?}",
            agent_id,
            candidate.to_string_lossy(),
            parent_thread_id
        );
        if parent_thread_id.as_deref() == Some(parent_session_id.as_str()) {
            info!(
                "[subagent_transcript:codex] rollout matched: agentId={} path={}",
                agent_id,
                candidate.to_string_lossy()
            );
            return Ok(Some(candidate.to_string_lossy().to_string()));
        }
    }

    info!(
        "[subagent_transcript:codex] rollout not found: root={} parentSessionId={} agentId={}",
        sessions_root.to_string_lossy(),
        parent_session_id,
        agent_id
    );

    Ok(None)
}

fn discover_wsl_subagent_files(
    cwd: &str,
    session_id: &str,
    distro: &str,
) -> Result<Vec<String>, String> {
    let linux_home = wsl_home_dir(distro)?;
    let linux_cwd = cwd_for_wsl_slug(cwd);
    let subagents_dir = format!(
        "{}/.claude/projects/{}/{}/subagents",
        linux_home.trim_end_matches('/'),
        slug_for_cwd(&linux_cwd),
        session_id
    );
    let pattern = "agent-\\*.jsonl";
    let args = [
        "find",
        subagents_dir.as_str(),
        "-maxdepth",
        "1",
        "-name",
        pattern,
        "-type",
        "f",
        "-printf",
        "%f\n",
    ];
    info!("[subagent_transcript:wsl] discover dir: distro={distro} dir={subagents_dir}");

    match wsl_command_text(distro, &args) {
        Ok((stdout, stderr)) => {
            if !stderr.trim().is_empty() {
                warn!(
                    "[subagent_transcript:wsl] discover stderr: {}",
                    stderr.trim()
                );
            }
            let files: Vec<String> = stdout
                .lines()
                .map(str::trim)
                .filter(|name| name.starts_with("agent-") && name.ends_with(".jsonl"))
                .map(ToString::to_string)
                .collect();
            info!(
                "[subagent_transcript:wsl] discover result: distro={distro} count={} files={:?}",
                files.len(),
                files
            );
            Ok(files)
        }
        Err(err) => {
            warn!(
                "[subagent_transcript:wsl] discover failed: distro={distro} dir={subagents_dir} error={}",
                err.trim()
            );
            Ok(Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_replaces_separators_only() {
        assert_eq!(
            slug_for_cwd(r"D:\work\pythonProject\CLI-Manager"),
            "D--work-pythonProject-CLI-Manager"
        );
        assert_eq!(slug_for_cwd("/home/u/proj"), "-home-u-proj");
        assert_eq!(slug_for_cwd("C:/a/b"), "C--a-b");
    }

    #[test]
    fn derive_builds_subagent_jsonl_path() {
        let home = Path::new(r"C:\Users\me");
        let path =
            derive_transcript_path(home, r"D:\work\pythonProject\CLI-Manager", "sess-1", "a99");
        let norm = path.replace('\\', "/");
        assert!(
            norm.ends_with(
                ".claude/projects/D--work-pythonProject-CLI-Manager/sess-1/subagents/agent-a99.jsonl"
            ),
            "got {path}"
        );
    }

    #[test]
    fn resolve_prefers_explicit_transcript_path() {
        let explicit = home_dir()
            .unwrap()
            .join(".claude")
            .join("projects")
            .join("p")
            .join("s")
            .join("subagents")
            .join("agent-a.jsonl");
        let got = resolve_transcript_path(
            Some(format!("  {} ", explicit.to_string_lossy())),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(got, explicit.to_string_lossy());
    }

    #[test]
    fn resolve_rejects_explicit_transcript_path_outside_allowed_roots() {
        let err =
            resolve_transcript_path(Some(r"C:\tmp\a.jsonl".to_string()), None, None, None, None)
                .unwrap_err();
        assert!(
            err == "transcript_path_not_absolute" || err == "transcript_path_outside_allowed_roots",
            "got {err}"
        );
    }

    #[test]
    fn explicit_linux_path_converts_to_wsl_unc_when_distro_known() {
        let got = resolve_transcript_path(
            Some(" /home/me/.claude/projects/p/s/subagents/agent-a.jsonl ".to_string()),
            None,
            None,
            None,
            Some("Ubuntu-22.04".to_string()),
        )
        .unwrap();
        assert_eq!(
            got,
            r"\\wsl.localhost\Ubuntu-22.04\home\me\.claude\projects\p\s\subagents\agent-a.jsonl"
        );
    }

    #[test]
    fn explicit_native_path_stays_native_without_wsl_distro() {
        let explicit = home_dir()
            .unwrap()
            .join(".claude")
            .join("projects")
            .join("p")
            .join("s")
            .join("subagents")
            .join("agent-a.jsonl");
        let got = resolve_transcript_path(
            Some(format!(" {} ", explicit.to_string_lossy())),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(got, explicit.to_string_lossy());
    }

    #[test]
    fn derives_wsl_unc_path_from_windows_cwd_using_linux_slug() {
        let got = derive_wsl_unc_transcript_path(
            "/home/me",
            r"D:\work\pythonProject\CLI-Manager",
            "sess-1",
            "a99",
            "Ubuntu",
        );
        assert_eq!(
            got,
            r"\\wsl.localhost\Ubuntu\home\me\.claude\projects\-mnt-d-work-pythonProject-CLI-Manager\sess-1\subagents\agent-a99.jsonl"
        );
    }

    #[test]
    fn resolves_wsl_distro_from_unc_cwd_when_env_missing() {
        let got = resolve_wsl_distro_name(Some(r"\\wsl.localhost\Ubuntu\data\test\sys"), None);
        assert_eq!(got.as_deref(), Some("Ubuntu"));
    }

    #[test]
    fn resolves_default_wsl_codex_config_root_from_linux_home() {
        let got = resolve_wsl_codex_config_root(None, "Ubuntu", "/home/me").unwrap();
        assert_eq!(got, "/home/me/.codex");
    }

    #[test]
    fn resolves_wsl_codex_config_root_path_variants() {
        assert_eq!(
            resolve_wsl_codex_config_root(
                Some("/home/me/custom-codex".to_string()),
                "Ubuntu",
                "/home/me",
            )
            .unwrap(),
            "/home/me/custom-codex"
        );
        assert_eq!(
            resolve_wsl_codex_config_root(
                Some(r"\\wsl$\Ubuntu\home\me\.codex".to_string()),
                "Ubuntu",
                "/home/me",
            )
            .unwrap(),
            "/home/me/.codex"
        );
        assert_eq!(
            resolve_wsl_codex_config_root(
                Some(r"C:\Users\me\.codex".to_string()),
                "Ubuntu",
                "/home/me",
            )
            .unwrap(),
            "/mnt/c/Users/me/.codex"
        );
    }

    #[test]
    fn resolves_wsl_codex_sessions_root_from_parent_transcript() {
        let got = resolve_wsl_codex_sessions_root(
            None,
            Some("/root/.codex/sessions/2026/07/17/rollout-parent.jsonl".to_string()),
            "Ubuntu",
        )
        .unwrap();
        assert_eq!(
            got.to_string_lossy(),
            r"\\wsl.localhost\Ubuntu\root\.codex\sessions"
        );
    }

    #[test]
    fn explicit_wsl_distro_overrides_unc_cwd() {
        let got = resolve_wsl_distro_name(
            Some(r"\\wsl.localhost\Ubuntu\data\test\sys"),
            Some("Debian".to_string()),
        );
        assert_eq!(got.as_deref(), Some("Debian"));
    }

    #[test]
    fn resolve_requires_parts_when_no_explicit_path() {
        let err = resolve_transcript_path(None, None, None, None, None).unwrap_err();
        // 缺 home 或缺 cwd 都应报错（不静默编出错误路径）。
        assert!(err == "missing_cwd" || err == "no_home_dir", "got {err}");
    }

    #[test]
    fn read_new_lines_returns_offset_for_complete_lines_only() {
        let path = std::env::temp_dir().join(format!(
            "cli-manager-subagent-transcript-{}.jsonl",
            std::process::id()
        ));
        fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"partial\":").unwrap();

        let (content, offset, shrank) = read_new_lines(&path, 0).unwrap();
        assert_eq!(content, "{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(offset as usize, content.len());
        assert!(!shrank);

        fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n").unwrap();
        let (content, next_offset, shrank) = read_new_lines(&path, offset).unwrap();
        assert_eq!(content, "{\"c\":3}\n");
        assert_eq!(
            next_offset as usize,
            "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n".len()
        );
        assert!(!shrank);

        let _ = fs::remove_file(path);
    }
}
