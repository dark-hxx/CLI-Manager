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
            info!(
                "[subagent_transcript] tail read lines: key={key} bytes={} offset={} reset={reset}",
                content.len(),
                offset
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
    let (start, shrank) = if len < offset {
        (0u64, true)
    } else {
        (offset, false)
    };
    if len <= start {
        return None;
    }

    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;

    // 只发送到最后一个换行；残行留到下次（换行是 ASCII，切点同时是 UTF-8 边界）。
    let last_nl = buf.iter().rposition(|&b| b == b'\n')?;
    let complete = &buf[..=last_nl];
    let consumed = start + complete.len() as u64;
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
    value.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
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

fn list_native_codex_rollout_candidates(root: &Path, agent_id: &str) -> Vec<PathBuf> {
    let expected_suffix = format!("-{agent_id}.jsonl");
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
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
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name.starts_with("rollout-") && name.ends_with(&expected_suffix) {
                out.push(path);
            }
        }
    }

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
    match wsl_command_text(&distro, &args) {
        Ok((stdout, stderr)) => {
            if !stderr.trim().is_empty() {
                warn!(
                    "[subagent_transcript:codex] wsl discover stderr: {}",
                    stderr.trim()
                );
            }
            stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(|line| PathBuf::from(crate::wsl::linux_to_unc_wsl_path(line, &distro)))
                .collect()
        }
        Err(err) => {
            warn!(
                "[subagent_transcript:codex] wsl discover failed: root={} agentId={} error={err}",
                root_str,
                agent_id
            );
            Vec::new()
        }
    }
}

fn list_codex_rollout_candidates(root: &Path, agent_id: &str) -> Vec<PathBuf> {
    let root_str = root.to_string_lossy().to_string();
    if crate::wsl::is_wsl_config_dir(&root_str) {
        return list_wsl_codex_rollout_candidates(root, agent_id);
    }
    list_native_codex_rollout_candidates(root, agent_id)
}

fn codex_rollout_parent_thread_id(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let mut first_line = String::new();
    use std::io::BufRead;
    reader.read_line(&mut first_line).ok()?;
    let json: Value = serde_json::from_str(first_line.trim()).ok()?;
    if json.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = json.get("payload")?;
    trimmed_str(payload.get("parent_thread_id").and_then(Value::as_str))
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
                return Ok(normalize_explicit_transcript_path(explicit, Some(&distro)));
            }
            return Ok(normalize_explicit_transcript_path(explicit, None));
        }
        info!(
            "[subagent_transcript] resolving explicit transcript path: hasWslDistro={} isLinuxPath={}",
            wsl_distro_name.as_deref().is_some_and(|v| !v.trim().is_empty()),
            is_linux_absolute_path(&explicit)
        );
        return Ok(normalize_explicit_transcript_path(
            explicit,
            wsl_distro_name.as_deref(),
        ));
    }

    let cwd = trimmed(cwd).ok_or_else(|| "missing_cwd".to_string())?;
    let session_id = trimmed(session_id).ok_or_else(|| "missing_session_id".to_string())?;
    let agent_id = trimmed(agent_id).ok_or_else(|| "missing_agent_id".to_string())?;
    if let Some(distro) = trimmed(wsl_distro_name) {
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
    if let Some(distro) = trimmed(wsl_distro_name) {
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
) -> Result<Option<String>, String> {
    let parent_session_id = parent_session_id.trim().to_string();
    let agent_id = agent_id.trim().to_string();
    if parent_session_id.is_empty() {
        return Err("missing_parent_session_id".to_string());
    }
    if agent_id.is_empty() {
        return Err("missing_agent_id".to_string());
    }

    let sessions_root = resolve_codex_sessions_root(codex_config_dir);
    if !sessions_root.exists() {
        info!(
            "[subagent_transcript:codex] sessions root missing: {}",
            sessions_root.to_string_lossy()
        );
        return Ok(None);
    }

    for candidate in list_codex_rollout_candidates(&sessions_root, &agent_id) {
        let parent_thread_id = codex_rollout_parent_thread_id(&candidate);
        info!(
            "[subagent_transcript:codex] inspect rollout candidate: agentId={} path={} parentThreadId={:?}",
            agent_id,
            candidate.to_string_lossy(),
            parent_thread_id
        );
        if parent_thread_id.as_deref() == Some(parent_session_id.as_str()) {
            return Ok(Some(candidate.to_string_lossy().to_string()));
        }
    }

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
        let got = resolve_transcript_path(
            Some(r"  C:\tmp\a.jsonl ".to_string()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(got, r"C:\tmp\a.jsonl");
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
    fn explicit_native_posix_path_stays_native_without_wsl_distro() {
        let got = resolve_transcript_path(
            Some(" /Users/me/.claude/projects/p/s/subagents/agent-a.jsonl ".to_string()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            got,
            "/Users/me/.claude/projects/p/s/subagents/agent-a.jsonl"
        );
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
