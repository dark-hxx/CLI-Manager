use super::{
    get_wsl_session_fingerprint_cache, now_millis, path_to_key, CachedWslSessionFingerprint,
    SessionFileFingerprint, SessionFileRef, WslSessionFileHit,
};
use crate::shell_resolver::silent_command;
use log::{debug, warn};
use std::path::{Path, PathBuf};
use std::process::Output;

pub(super) fn wsl_command_output(program: &str, args: &[&str]) -> Result<Output, String> {
    let mut cmd = silent_command(program);
    cmd.args(args);
    cmd.output()
        .map_err(|err| format!("wsl command '{program} {}' failed: {err}", args.join(" ")))
}

/// 执行 wsl 命令并返回 stdout + stderr 文本，失败时返回错误信息。
pub(super) fn wsl_command_text(program: &str, args: &[&str]) -> Result<(String, String), String> {
    let output = wsl_command_output(program, args)?;
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

/// 通过 `wsl.exe find` 在 WSL 内递归列出 JSONL 会话文件，
/// 返回路径与 find 一次性带出的基础元数据，避免后续对每个文件再 shell out `stat`。
pub(super) fn wsl_find_session_files(
    linux_dir: &str,
    distro: &str,
    name_pattern: &str,
    project_key_from_path: &dyn Fn(&str) -> String,
) -> Vec<WslSessionFileHit> {
    let wsl_exe = crate::wsl::find_wsl_exe();
    let wsl_exe_str = wsl_exe
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string());

    let args = [
        "-d",
        distro,
        "--exec",
        "find",
        linux_dir,
        "-name",
        name_pattern,
        "-type",
        "f",
        "-printf",
        "%p\t%s\t%T@\n",
    ];
    debug!(
        "[wsl] 枚举会话文件: wsl.exe -d {distro} find {linux_dir} -name '{name_pattern}' -type f"
    );
    let started_at = now_millis();
    let result = wsl_command_text(&wsl_exe_str, &args);

    match result {
        Ok((stdout, stderr)) => {
            let mut total_lines = 0usize;
            let mut skipped_lines = 0usize;
            let mut files = Vec::new();
            for line in stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                total_lines += 1;
                if let Some(hit) = parse_wsl_find_session_file_line(line, project_key_from_path) {
                    files.push(hit);
                } else {
                    skipped_lines += 1;
                }
            }

            debug!(
                "[wsl] 枚举完成: distro={distro} dir={linux_dir} pattern={name_pattern} files={} skipped={} raw_lines={} elapsed_ms={}",
                files.len(),
                skipped_lines,
                total_lines,
                now_millis().saturating_sub(started_at)
            );
            if !stderr.trim().is_empty() {
                warn!("[wsl] find stderr: {}", stderr.trim());
            }
            if files.is_empty() {
                warn!(
                    "[wsl] find 返回空: distro={distro} dir={linux_dir} — 可能目录不存在或权限不足"
                );
            }
            files
        }
        Err(err) => {
            warn!(
                "[wsl] find 执行失败: distro={distro} dir={linux_dir} elapsed_ms={} error={}",
                now_millis().saturating_sub(started_at),
                err.trim()
            );
            Vec::new()
        }
    }
}

pub(super) fn parse_wsl_find_timestamp_millis(raw: &str) -> i64 {
    raw.trim()
        .parse::<f64>()
        .ok()
        .map(|seconds| (seconds * 1000.0).round() as i64)
        .filter(|millis| *millis > 0)
        .unwrap_or(0)
}

pub(super) fn parse_wsl_find_session_file_line(
    line: &str,
    project_key_from_path: &dyn Fn(&str) -> String,
) -> Option<WslSessionFileHit> {
    let mut parts = line.rsplitn(3, '\t');
    let mtime_raw = parts.next()?;
    let size_raw = parts.next()?;
    let linux_path = parts.next()?.trim();
    if linux_path.is_empty() || !linux_path.ends_with(".jsonl") {
        return None;
    }

    let size = size_raw.trim().parse::<u64>().unwrap_or(0);
    let updated_at = parse_wsl_find_timestamp_millis(mtime_raw);
    let fingerprint = SessionFileFingerprint {
        created_at: updated_at,
        updated_at,
        size,
    };

    Some(WslSessionFileHit {
        linux_path: linux_path.to_string(),
        project_key: project_key_from_path(linux_path),
        fingerprint,
    })
}

pub(super) fn remember_wsl_session_fingerprint(
    unc_path: &str,
    fingerprint: SessionFileFingerprint,
) {
    if let Ok(mut cache) = get_wsl_session_fingerprint_cache().lock() {
        cache.insert(
            path_to_key(Path::new(unc_path)),
            CachedWslSessionFingerprint {
                fingerprint,
                cached_at: now_millis(),
            },
        );
    }
}

/// 通过 `wsl.exe stat` 获取文件元数据（size / mtime / ctime）。
pub(super) fn wsl_session_fingerprint(linux_path: &str, distro: &str) -> SessionFileFingerprint {
    let wsl_exe = crate::wsl::find_wsl_exe();
    let wsl_exe_str = wsl_exe
        .as_deref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "wsl.exe".to_string());

    let args = ["-d", distro, "--exec", "stat", "-c", "%s %Y %W", linux_path];
    let result = wsl_command_text(&wsl_exe_str, &args);

    match result {
        Ok((stdout, _stderr)) => {
            let parts: Vec<&str> = stdout.trim().split_whitespace().collect();
            if parts.len() < 3 {
                warn!(
                    "[wsl] stat 输出格式异常: distro={distro} path={linux_path} stdout='{}'",
                    stdout.trim()
                );
                return SessionFileFingerprint::default();
            }

            let size: u64 = parts[0].parse().unwrap_or(0);
            let mtime: i64 = parts[1].parse().unwrap_or(0);
            let ctime: i64 = parts[2].parse().unwrap_or(0);
            let created_at = if ctime > 0 {
                ctime * 1000
            } else {
                mtime * 1000
            };

            SessionFileFingerprint {
                created_at,
                updated_at: (mtime * 1000).max(created_at),
                size,
            }
        }
        Err(err) => {
            warn!(
                "[wsl] stat 执行失败: distro={distro} path={linux_path} error={}",
                err.trim()
            );
            SessionFileFingerprint::default()
        }
    }
}

/// Claude: 从 Linux 路径提取 project_key（projects 目录下的第一级子目录名）。
pub(super) fn claude_project_key_from_wsl_linux_path(linux_path: &str) -> String {
    let normalized = linux_path.trim_end_matches('/').replace('\\', "/");
    // 路径格式: /home/user/.claude/projects/<project_key>/<session>.jsonl
    // 找 "projects/" 之后的第一段
    if let Some(after_projects) = normalized.split("/projects/").nth(1) {
        if let Some(key) = after_projects.split('/').next() {
            if !key.is_empty() {
                return key.to_string();
            }
        }
    }
    // 回退：取父目录名
    std::path::Path::new(&normalized)
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "default".to_string())
}

/// Codex: 从 Linux 路径提取 project_key（sessions 目录下的相对路径）。
pub(super) fn codex_project_key_from_wsl_linux_path(linux_path: &str, linux_root: &str) -> String {
    let normalized = linux_path.trim_end_matches('/').replace('\\', "/");
    let root_normalized = linux_root.trim_end_matches('/').replace('\\', "/");
    // sessions/<project_key>/ 或 sessions/<project_key>/<sub>/rollout-xxx.jsonl
    if let Some(tail) = normalized.strip_prefix(&format!("{root_normalized}/",)) {
        if let Some(rel) = tail.split('/').next() {
            if !rel.is_empty() {
                return rel.to_string();
            }
        }
    }
    "sessions".to_string()
}

pub(super) fn collect_wsl_claude_session_files(
    linux_projects_dir: &str,
    distro: &str,
) -> Vec<SessionFileRef> {
    debug!("[wsl] 开始扫描 Claude 会话: distro={distro} projects_dir={linux_projects_dir}");
    let results = wsl_find_session_files(linux_projects_dir, distro, "*.jsonl", &|linux_path| {
        claude_project_key_from_wsl_linux_path(linux_path)
    });

    let files: Vec<_> = results
        .into_iter()
        .map(|hit| {
            let linux_path = hit.linux_path;
            let unc = crate::wsl::linux_to_unc_wsl_path(&linux_path, distro);
            remember_wsl_session_fingerprint(&unc, hit.fingerprint);
            debug!(
                "[wsl] Claude session: project_key={} path={unc}",
                hit.project_key
            );
            SessionFileRef {
                source: "claude".to_string(),
                project_key: hit.project_key,
                path: PathBuf::from(unc),
            }
        })
        .collect();
    debug!(
        "[wsl] Claude 会话扫描完成: distro={distro} total_files={}",
        files.len()
    );
    files
}

pub(super) fn collect_wsl_codex_session_files(
    linux_sessions_dir: &str,
    distro: &str,
) -> Vec<SessionFileRef> {
    debug!("[wsl] 开始扫描 Codex 会话: distro={distro} sessions_dir={linux_sessions_dir}");
    let results = wsl_find_session_files(
        linux_sessions_dir,
        distro,
        "rollout-*.jsonl",
        &|linux_path| codex_project_key_from_wsl_linux_path(linux_path, linux_sessions_dir),
    );

    let files: Vec<_> = results
        .into_iter()
        .map(|hit| {
            let linux_path = hit.linux_path;
            let unc = crate::wsl::linux_to_unc_wsl_path(&linux_path, distro);
            remember_wsl_session_fingerprint(&unc, hit.fingerprint);
            debug!(
                "[wsl] Codex session: project_key={} path={unc}",
                hit.project_key
            );
            SessionFileRef {
                source: "codex".to_string(),
                project_key: hit.project_key,
                path: PathBuf::from(unc),
            }
        })
        .collect();
    debug!(
        "[wsl] Codex 会话扫描完成: distro={distro} total_files={}",
        files.len()
    );
    files
}
