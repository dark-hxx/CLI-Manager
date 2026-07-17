use log::{debug, error, info, warn};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::pty::boundary::safe_emit_boundary;
use crate::pty::platform::{self, PlatformPtyChild, PlatformPtyController, PtyLaunchOptions};
use crate::shell_resolver::{resolve_git_bash_exe, GIT_BASH_NOT_FOUND_MESSAGE};

/// PTY 输出/状态事件出口（Issue #123 Phase 2 解耦点）：
/// daemon 实现为尺寸化 replay + WebSocket 二进制推送。
///
/// 契约：`data` 已经过 `safe_emit_boundary` 切帧（UTF-8 + ANSI 序列安全边界），
/// 实现方只允许整帧透传/存储，禁止再分片。
pub trait PtyEventSink: Send + Sync + 'static {
    fn on_output(&self, session_id: &str, data: &[u8]);
    fn on_status(&self, session_id: &str, status: PtyProcessStatus);
}

/// Reader 累积阈值：达到该阈值或下游显式没有更多数据时才 emit，避免高吞吐时
/// 每次 read 都触发一次 IPC + Base64 编码。
const READER_FLUSH_THRESHOLD: usize = 32 * 1024;
const READER_BUF_SIZE: usize = 16 * 1024;
const MIN_PTY_COLS: u16 = 40;
const MIN_PTY_ROWS: u16 = 8;
const GIT_BASH_INITIAL_OUTPUT_DELAY_MS: u64 = 250;
const ORPHAN_CREATE_GRACE_SECS: u64 = 30;
const ORPHAN_MISSING_GRACE_SECS: u64 = 90;

/// Debug 诊断（CLI_MANAGER_DEBUG=1）：统计影响滚动条/回滚的关键 VT 序列，
/// 用于排查 Codex 等 TUI 在不同机器上滚动条表现不一致的问题。
/// 判定：出现 `?1049h` 说明 TUI 进了 alternate screen（xterm.js 备用缓冲区无
/// scrollback，滚动条必然消失）；出现 `3J` 说明普通缓冲区回滚被主动清空；
/// DECSTBM/RI 是区域滚动重绘路径（xterm.js 中不进 scrollback）的证据。
#[derive(Default)]
struct VtScrollDiag {
    alt_enter: u64,
    alt_exit: u64,
    ed2: u64,
    ed3: u64,
    decstbm: u64,
    ri: u64,
}

/// 调用方需保证 data 处于 ANSI 序列安全边界内（safe_emit_boundary 已保证），
/// 否则跨块被切半的序列会漏计。
fn scan_vt_scroll_sequences(data: &[u8], diag: &mut VtScrollDiag, session_id: &str) {
    let mut i = 0;
    while i + 1 < data.len() {
        if data[i] != 0x1b {
            i += 1;
            continue;
        }
        // ESC M = RI（reverse index），区域滚动插入历史的常用路径
        if data[i + 1] == b'M' {
            if diag.ri == 0 {
                debug!("pty vt-diag: id={session_id}, first RI (ESC M)");
            }
            diag.ri += 1;
            i += 2;
            continue;
        }
        if data[i + 1] != b'[' {
            i += 1;
            continue;
        }
        let params_start = i + 2;
        let mut j = params_start;
        while j < data.len() && matches!(data[j], b'0'..=b'9' | b';' | b'?') {
            j += 1;
        }
        if j >= data.len() {
            break;
        }
        let params = &data[params_start..j];
        let hit: Option<(&mut u64, &str)> = match (data[j], params) {
            (b'h', b"?1049") => Some((&mut diag.alt_enter, "alt-screen enter (?1049h)")),
            (b'l', b"?1049") => Some((&mut diag.alt_exit, "alt-screen exit (?1049l)")),
            (b'J', b"2") => Some((&mut diag.ed2, "ED2 clear screen (2J)")),
            (b'J', b"3") => Some((&mut diag.ed3, "ED3 clear scrollback (3J)")),
            // 排除 `CSI ? Pm r`（DEC 私有模式 restore），其余 `CSI Ps;Ps r` 按 DECSTBM 计
            (b'r', p) if !p.starts_with(b"?") => {
                Some((&mut diag.decstbm, "DECSTBM scroll region (r)"))
            }
            _ => None,
        };
        if let Some((count, name)) = hit {
            if *count == 0 {
                debug!("pty vt-diag: id={session_id}, first {name}");
            }
            *count += 1;
        }
        i = j + 1;
    }
}

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    controller: Box<dyn PlatformPtyController>,
    child: Arc<dyn PlatformPtyChild>,
    diagnostics: Arc<Mutex<PtySessionDiagnostics>>,
    reader_handle: Option<JoinHandle<()>>,
    created_at: Instant,
    missing_since: Option<Instant>,
}

#[derive(Clone)]
struct PtySessionDiagnostics {
    session_id: String,
    shell: String,
    exe: String,
    cwd: Option<String>,
    last_resize_cols: Option<u16>,
    last_resize_rows: Option<u16>,
}

#[derive(Clone, Serialize)]
pub struct PtyProcessStatus {
    pub status: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct PtyOrphanCleanupSummary {
    pub active_count: usize,
    pub tracked_count: usize,
    pub marked_missing: usize,
    pub protected_count: usize,
    pub cleaned_count: usize,
    pub skipped_empty_active_list: bool,
}

pub struct PtyManager {
    sessions: RwLock<HashMap<String, Arc<Mutex<PtySession>>>>,
    statuses: Arc<Mutex<HashMap<String, PtyProcessStatus>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ShellLaunchLogContext {
    requested_shell: Option<String>,
    shell_key: String,
    exe: String,
    args: Vec<String>,
    login_shell: bool,
    cwd: Option<String>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            statuses: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn default_shell_key() -> &'static str {
        if cfg!(target_os = "windows") {
            "powershell"
        } else if cfg!(target_os = "macos") {
            "zsh"
        } else {
            "bash"
        }
    }

    fn resolve_custom_shell_path(shell: &str) -> Result<Option<String>, String> {
        let trimmed = shell.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let looks_like_path =
            trimmed.contains('\\') || trimmed.contains('/') || Path::new(trimmed).is_absolute();
        if !looks_like_path {
            return Ok(None);
        }
        let path = Path::new(trimmed);
        if path.is_file() {
            return Ok(Some(trimmed.to_string()));
        }
        Err(format!("Shell executable not found: {trimmed}"))
    }

    fn resolve_shell(shell: &str) -> Result<(String, Vec<String>), String> {
        if let Some(custom_shell) = Self::resolve_custom_shell_path(shell)? {
            return Ok((custom_shell, Vec::new()));
        }
        match shell {
            // Windows shells
            "cmd" if cfg!(target_os = "windows") => {
                Ok(("cmd.exe".to_string(), vec!["/Q".to_string()]))
            }
            "pwsh" => {
                let exe = if cfg!(target_os = "windows") {
                    "pwsh.exe"
                } else {
                    "pwsh"
                };
                Ok((exe.to_string(), vec!["-NoLogo".to_string()]))
            }
            "wsl" if cfg!(target_os = "windows") => Ok(("wsl.exe".to_string(), Vec::new())),
            "gitbash" if cfg!(target_os = "windows") => resolve_git_bash_exe()
                .map(|path| {
                    (
                        path.to_string_lossy().into_owned(),
                        Self::git_bash_login_args(),
                    )
                })
                .ok_or_else(|| GIT_BASH_NOT_FOUND_MESSAGE.to_string()),
            // Unix shells (macOS, Linux)
            "zsh" => Ok(("zsh".to_string(), Self::zsh_login_args())),
            "fish" => Ok(("fish".to_string(), Vec::new())),
            "sh" => Ok(("sh".to_string(), Vec::new())),
            "bash" => {
                // Windows: bash.exe（WSL/Git 自带）；Unix: bash
                if cfg!(target_os = "windows") {
                    Ok(("bash.exe".to_string(), Vec::new()))
                } else {
                    Ok(("bash".to_string(), Self::bash_login_args()))
                }
            }
            // 默认：Windows 用 powershell；Unix 用用户的登录 shell（$SHELL），
            // 回退到平台惯用默认（macOS=zsh，其它=bash）
            _ => {
                if cfg!(target_os = "windows") {
                    Ok(("powershell.exe".to_string(), vec!["-NoLogo".to_string()]))
                } else {
                    let fallback = if cfg!(target_os = "macos") {
                        "zsh"
                    } else {
                        "bash"
                    };
                    let shell = std::env::var("SHELL").unwrap_or_else(|_| fallback.to_string());
                    Ok((shell, Vec::new()))
                }
            }
        }
    }

    fn shell_runtime_monitoring_enabled(env_vars: Option<&HashMap<String, String>>) -> bool {
        env_vars
            .and_then(|vars| vars.get("CLI_MANAGER_SHELL_RUNTIME_MONITORING"))
            .map(|value| value == "1")
            .unwrap_or(false)
    }

    fn git_bash_login_args() -> Vec<String> {
        vec!["--login".to_string(), "-i".to_string()]
    }

    fn zsh_login_args() -> Vec<String> {
        if cfg!(target_os = "macos") {
            vec!["-l".to_string()]
        } else {
            Vec::new()
        }
    }

    fn bash_login_args() -> Vec<String> {
        if cfg!(target_os = "macos") {
            vec!["--login".to_string(), "-i".to_string()]
        } else {
            Vec::new()
        }
    }

    fn shell_args_include_login(args: &[String]) -> bool {
        args.iter().any(|arg| arg == "-l" || arg == "--login")
    }

    fn build_shell_launch_log_context(
        requested_shell: Option<&str>,
        shell_key: &str,
        exe: &str,
        args: &[String],
        cwd: Option<&str>,
    ) -> ShellLaunchLogContext {
        ShellLaunchLogContext {
            requested_shell: requested_shell.map(str::to_string),
            shell_key: shell_key.to_string(),
            exe: exe.to_string(),
            args: args.to_vec(),
            login_shell: Self::shell_args_include_login(args),
            cwd: cwd.map(str::to_string),
        }
    }

    /// 让 hook 回调环境变量跨进 WSL：把它们追加进 WSLENV（无 flag = Win↔WSL 双向共享），
    /// 既进 Linux shell，又能在 claude 经 interop 调 Windows 端 cli-manager.exe 时回传。
    /// 合并已有 WSLENV（注入批次或进程环境），不覆盖用户原有项。
    fn apply_wsl_env_forwarding(env_vars: &mut HashMap<String, String>) {
        const FORWARD: [&str; 3] = [
            "CLI_MANAGER_TAB_ID",
            "CLI_MANAGER_NOTIFY_PORT",
            "CLI_MANAGER_NOTIFY_TOKEN",
        ];
        let present: Vec<&str> = FORWARD
            .iter()
            .copied()
            .filter(|key| env_vars.contains_key(*key))
            .collect();
        if present.is_empty() {
            return;
        }

        let mut entries: Vec<String> = env_vars
            .get("WSLENV")
            .cloned()
            .or_else(|| std::env::var("WSLENV").ok())
            .map(|existing| {
                existing
                    .split(':')
                    .filter(|item| !item.is_empty())
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();

        for key in present {
            // WSLENV 项可能带 /u /w 等 flag，比对名字部分去重
            let already = entries
                .iter()
                .any(|entry| entry.split('/').next() == Some(key));
            if !already {
                entries.push(key.to_string());
            }
        }

        env_vars.insert("WSLENV".to_string(), entries.join(":"));
    }

    fn powershell_runtime_monitor_args() -> Vec<String> {
        // 标准 FinalTerm OSC 133 shell integration（前端 XTermTerminal 原始流解析）：
        //   D[;exit] = 命令结束（无 exit 表示没跑命令：空回车 / prompt 处 Ctrl+C）
        //   A = prompt 开始；B = prompt 结束
        //   C = 命令开始执行（PSConsoleHostReadLine 提交非空行时发出）
        // 是否真的跑过命令用 history id 判断，避免空回车误报 command_finished。
        let script = r#"
$global:CliManagerLastHistoryId = $null
$global:CliManagerPreviousPrompt = if (Test-Path function:\prompt) { (Get-Command prompt).ScriptBlock } else { $null }
function global:prompt {
  $success = $?
  $nativeExitCode = $global:LASTEXITCODE
  $esc = [char]27
  $bel = [char]7
  $lastHistory = Get-History -Count 1
  $lastId = if ($lastHistory) { $lastHistory.Id } else { -1 }
  $out = ""
  if (($null -ne $global:CliManagerLastHistoryId) -and ($lastId -ne $global:CliManagerLastHistoryId)) {
    $exitCode = if ($success) { 0 } elseif ($nativeExitCode -is [int] -and $nativeExitCode -ne 0) { $nativeExitCode } else { 1 }
    $out += "$esc]133;D;$exitCode$bel"
  } else {
    $out += "$esc]133;D$bel"
  }
  $global:CliManagerLastHistoryId = $lastId
  $out += "$esc]133;A$bel"
  $promptText = if ($global:CliManagerPreviousPrompt) { & $global:CliManagerPreviousPrompt } else { 'PS ' + (Get-Location) + '> ' }
  "$out$promptText$esc]133;B$bel"
}
if (-not (Get-Module -Name PSReadLine)) { Import-Module PSReadLine -ErrorAction SilentlyContinue }
if (Test-Path function:\PSConsoleHostReadLine) {
  $global:CliManagerOriginalReadLine = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $line = & $global:CliManagerOriginalReadLine
    if (($null -ne $line) -and ($line.Trim().Length -gt 0)) {
      [Console]::Write("$([char]27)]133;C$([char]7)")
    }
    $line
  }
}
"#;
        vec![
            "-NoLogo".to_string(),
            "-NoExit".to_string(),
            "-Command".to_string(),
            script.to_string(),
        ]
    }

    /// Git Bash 的 OSC 133 集成 rcfile：先加载 Git for Windows /etc/profile 与用户 ~/.bashrc，
    /// 再追加我们的钩子，保证 PROMPT_COMMAND / PS0 不被用户配置覆盖。
    /// PS0 仅在交互式命令真正执行前展开（bash 4.4+），用 `${PS0:0:$((var=1,0))}`
    /// 技巧完成无输出赋值，替代 DEBUG trap（trap 会被 PROMPT_COMMAND 自身误触发）。
    fn write_bash_integration_rcfile() -> Result<String, String> {
        let script = r#"[ -f /etc/profile ] && . /etc/profile
[ -f ~/.bashrc ] && . ~/.bashrc
__cli_manager_prompt() {
  local exit_code=$?
  if [ "${__cli_manager_ran:-0}" = "1" ]; then
    printf '\033]133;D;%s\007' "$exit_code"
    __cli_manager_ran=0
  else
    printf '\033]133;D\007'
  fi
  printf '\033]133;A\007'
}
PROMPT_COMMAND="__cli_manager_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS0='\e]133;C\a${PS0:0:$((__cli_manager_ran=1,0))}'
"#;
        let path = std::env::temp_dir().join("cli-manager-bash-integration.bashrc");
        std::fs::write(&path, script).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().replace('\\', "/"))
    }

    /// cmd 经 PROMPT 环境变量注入 133 标记（$E=ESC，$E\ = ST 终止符）。
    /// cmd 拿不到上一条命令的 exit code，D 恒不带参数；running 由前端输入侧
    /// 猜测提供，prompt 重现（A）时收口为 done。
    fn apply_cmd_prompt_integration(env_vars: &mut HashMap<String, String>) {
        let base = env_vars
            .get("PROMPT")
            .cloned()
            .or_else(|| std::env::var("PROMPT").ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "$P$G".to_string());
        env_vars.insert(
            "PROMPT".to_string(),
            format!("$E]133;D$E\\$E]133;A$E\\{base}$E]133;B$E\\"),
        );
    }

    #[cfg(target_os = "windows")]
    fn kill_process_tree(pid: u32) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let pid_arg = pid.to_string();
        let output = Command::new("taskkill")
            .args(["/PID", pid_arg.as_str(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("taskkill start failed for pid {pid}: {e}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(format!(
            "taskkill failed for pid {pid}: status={}, detail={}",
            output.status, detail
        ))
    }

    /// 批量终止多个 PTY 根进程树：taskkill 原生支持多 /PID，单次调用避免
    /// 退出时逐会话 spawn taskkill 造成的串行等待。仅作用于本应用拥有的 PTY 根 PID。
    #[cfg(target_os = "windows")]
    fn kill_process_trees(pids: &[u32]) -> Result<(), String> {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if pids.is_empty() {
            return Ok(());
        }
        let mut command = Command::new("taskkill");
        for pid in pids {
            command.arg("/PID").arg(pid.to_string());
        }
        let output = command
            .args(["/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("taskkill start failed for pids {pids:?}: {e}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(format!(
            "taskkill failed for pids {pids:?}: status={}, detail={}",
            output.status, detail
        ))
    }

    #[cfg(not(target_os = "windows"))]
    fn kill_process_group(pid: u32) -> Result<(), String> {
        if pid == 0 {
            return Err("invalid_pid".to_string());
        }
        let pgid = format!("-{pid}");
        let output = std::process::Command::new("kill")
            .args(["-TERM", pgid.as_str()])
            .output()
            .map_err(|e| format!("kill start failed for process group {pgid}: {e}"))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        Err(format!(
            "kill failed for process group {pgid}: status={}, detail={}",
            output.status, detail
        ))
    }

    fn build_shell_args(
        shell: &str,
        env_vars: Option<&HashMap<String, String>>,
    ) -> Result<(String, Vec<String>), String> {
        let monitoring_enabled = Self::shell_runtime_monitoring_enabled(env_vars);
        if !monitoring_enabled {
            return Self::resolve_shell(shell);
        }
        match shell {
            "powershell" if cfg!(target_os = "windows") => Ok((
                "powershell.exe".to_string(),
                Self::powershell_runtime_monitor_args(),
            )),
            "pwsh" => {
                let exe = if cfg!(target_os = "windows") {
                    "pwsh.exe"
                } else {
                    "pwsh"
                };
                Ok((exe.to_string(), Self::powershell_runtime_monitor_args()))
            }
            // gitbash 是确定的 Windows 原生 bash，可安全注入 rcfile；
            // "bash"（System32 的 WSL 启动器）与 wsl 一样无法可靠注入，
            // 仅依赖前端识别用户自带的 OSC 133/633 集成。
            "gitbash" if cfg!(target_os = "windows") => {
                let (exe, args) = Self::resolve_shell(shell)?;
                match Self::write_bash_integration_rcfile() {
                    Ok(rcfile) => Ok((exe, vec!["--rcfile".to_string(), rcfile, "-i".to_string()])),
                    Err(err) => {
                        warn!(
                            "bash integration rcfile write failed, fallback to plain shell: {err}"
                        );
                        Ok((exe, args))
                    }
                }
            }
            _ => Self::resolve_shell(shell),
        }
    }

    pub fn create(
        &self,
        session_id: &str,
        cwd: Option<&str>,
        env_vars: Option<HashMap<String, String>>,
        shell: Option<&str>,
        sink: Arc<dyn PtyEventSink>,
    ) -> Result<(), String> {
        let env_count = env_vars.as_ref().map(|vars| vars.len()).unwrap_or(0);
        info!(
            "pty session create: id={}, shell={:?}, cwd={:?}, env_vars={}",
            session_id, shell, cwd, env_count
        );
        let default_shell_key = Self::default_shell_key();
        let shell_key = shell.unwrap_or(default_shell_key);
        let mut env_vars = env_vars;
        if cfg!(target_os = "windows")
            && shell_key == "cmd"
            && Self::shell_runtime_monitoring_enabled(env_vars.as_ref())
        {
            Self::apply_cmd_prompt_integration(env_vars.get_or_insert_with(HashMap::new));
        }
        // WSL：wsl.exe 把 cwd 自动映射到 /mnt，但 cmd.env 设的是 Windows 进程环境，
        // 不经 WSLENV 不会进 Linux shell，导致 hook 回调变量丢失。
        if cfg!(target_os = "windows") && shell_key == "wsl" {
            if let Some(vars) = env_vars.as_mut() {
                Self::apply_wsl_env_forwarding(vars);
            }
        }
        if cfg!(target_os = "windows") && shell_key == "gitbash" {
            env_vars
                .get_or_insert_with(HashMap::new)
                .entry("CHERE_INVOKING".to_string())
                .or_insert_with(|| "1".to_string());
        }
        let (exe, args) = Self::build_shell_args(shell_key, env_vars.as_ref()).map_err(|e| {
            error!(
                "pty resolve shell failed: id={}, shell={}, error={}",
                session_id, shell_key, e
            );
            e
        })?;
        let launch_context =
            Self::build_shell_launch_log_context(shell, shell_key, &exe, &args, cwd);
        debug!(
            "pty shell launch: id={}, requested_shell={:?}, shell_key={}, exe={}, args={:?}, login_shell={}, cwd={:?}",
            session_id,
            launch_context.requested_shell,
            launch_context.shell_key,
            launch_context.exe,
            launch_context.args,
            launch_context.login_shell,
            launch_context.cwd
        );
        let mut launch_env = env_vars.unwrap_or_default();
        // 非 Windows：GUI 启动（Dock/Finder）时父进程没有 TERM，子进程继承空 TERM
        // 会导致 claude/codex/ls/git 等判定为非彩色终端而禁用 ANSI 颜色。
        // 显式注入 xterm-256color（xterm.js 完整支持）+ truecolor，让支持的工具走 24-bit。
        // 仅在调用方未自定义时补默认值，尊重用户偏好。
        if !cfg!(target_os = "windows") {
            launch_env
                .entry("TERM".to_string())
                .or_insert_with(|| "xterm-256color".to_string());
            launch_env
                .entry("COLORTERM".to_string())
                .or_insert_with(|| "truecolor".to_string());
        }

        let spawned = platform::spawn(PtyLaunchOptions {
            exe: exe.clone(),
            args: args.clone(),
            cwd: cwd.map(str::to_string),
            env: launch_env,
            cols: 80,
            rows: 24,
        })
        .map_err(|e| {
            error!(
                "pty spawn failed: id={}, exe={}, error={}",
                session_id, exe, e
            );
            e
        })?;
        let writer = spawned.writer;
        let mut reader = spawned.reader;
        let controller = spawned.controller;
        let child = spawned.child;
        let diagnostics = Arc::new(Mutex::new(PtySessionDiagnostics {
            session_id: session_id.to_string(),
            shell: shell.unwrap_or(default_shell_key).to_string(),
            exe: exe.to_string(),
            cwd: cwd.map(str::to_string),
            last_resize_cols: None,
            last_resize_rows: None,
        }));
        let status_map = self.statuses.clone();
        let child_for_thread = child.clone();
        let diagnostics_for_thread = diagnostics.clone();
        let session_id_owned = session_id.to_string();
        let defer_initial_output = cfg!(target_os = "windows") && shell_key == "gitbash";

        self.statuses.lock().unwrap().insert(
            session_id.to_string(),
            PtyProcessStatus {
                status: "running".to_string(),
                exit_code: None,
            },
        );

        let reader_handle = std::thread::spawn(move || {
            if defer_initial_output {
                std::thread::sleep(std::time::Duration::from_millis(
                    GIT_BASH_INITIAL_OUTPUT_DELAY_MS,
                ));
            }
            let mut buf = [0u8; READER_BUF_SIZE];
            let mut pending: Vec<u8> = Vec::with_capacity(READER_FLUSH_THRESHOLD * 2);
            let mut reader_end_reason = "eof".to_string();
            // 仅 debug 日志开启时扫描 VT 序列，正常运行零扫描开销
            let vt_diag_enabled = log::log_enabled!(log::Level::Debug);
            let mut vt_diag = VtScrollDiag::default();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // 每次底层 read 后立即交付安全前缀。若恰好读满 16 KiB 后
                        // 源端暂时停顿，下一次 read 可能长期阻塞，不能把这批输出
                        // 留在本层等待；5ms 合并由 daemon event sink 统一负责。
                        let safe = safe_emit_boundary(&pending);
                        if safe > 0 {
                            if vt_diag_enabled {
                                scan_vt_scroll_sequences(
                                    &pending[..safe],
                                    &mut vt_diag,
                                    &session_id_owned,
                                );
                            }
                            sink.on_output(&session_id_owned, &pending[..safe]);
                            pending.drain(..safe);
                        } else if pending.len() > READER_FLUSH_THRESHOLD * 8 {
                            // 极端兜底：未终结序列超 256KB（远大于任何正常 OSC/CSI），
                            // 说明源端格式异常，强制 emit 避免内存无限增长。
                            debug!(
                                "pty pending buffer overflowed boundary protection: id={}, len={}",
                                session_id_owned,
                                pending.len()
                            );
                            if vt_diag_enabled {
                                scan_vt_scroll_sequences(&pending, &mut vt_diag, &session_id_owned);
                            }
                            sink.on_output(&session_id_owned, &pending);
                            pending.clear();
                        }
                    }
                    Err(e) => {
                        reader_end_reason = format!("read_error: {e}");
                        break;
                    }
                }
            }
            // 进程退出，把剩余数据全部发出去（不再保护边界，最后一帧）
            if !pending.is_empty() {
                if vt_diag_enabled {
                    scan_vt_scroll_sequences(&pending, &mut vt_diag, &session_id_owned);
                }
                sink.on_output(&session_id_owned, &pending);
                pending.clear();
            }

            // Process exited — check exit status
            let (new_status, child_exit_status, child_exit_code_raw, child_wait_error) =
                match child_for_thread.try_wait() {
                    Ok(Some(exit)) => (
                        PtyProcessStatus {
                            status: "exited".to_string(),
                            exit_code: exit.code,
                        },
                        Some(exit.description),
                        exit.code,
                        None,
                    ),
                    Ok(None) => (
                        PtyProcessStatus {
                            status: "exited".to_string(),
                            exit_code: None,
                        },
                        None,
                        None,
                        None,
                    ),
                    Err(e) => (
                        PtyProcessStatus {
                            status: "error".to_string(),
                            exit_code: None,
                        },
                        None,
                        None,
                        Some(e),
                    ),
                };
            let diagnostics = diagnostics_for_thread.lock().unwrap().clone();
            info!(
                "pty reader ended: reason={}, id={}, status={}, exit_code={:?}, child_exit_status={:?}, child_exit_code_raw={:?}, shell={}, exe={}, cwd={:?}, last_resize_cols={:?}, last_resize_rows={:?}, child_wait_error={:?}",
                reader_end_reason,
                diagnostics.session_id,
                new_status.status,
                new_status.exit_code,
                child_exit_status,
                child_exit_code_raw,
                diagnostics.shell,
                diagnostics.exe,
                diagnostics.cwd,
                diagnostics.last_resize_cols,
                diagnostics.last_resize_rows,
                child_wait_error
            );
            if vt_diag_enabled {
                debug!(
                    "pty vt-diag summary: id={}, alt_enter={}, alt_exit={}, ed2={}, ed3={}, decstbm={}, ri={}",
                    session_id_owned,
                    vt_diag.alt_enter,
                    vt_diag.alt_exit,
                    vt_diag.ed2,
                    vt_diag.ed3,
                    vt_diag.decstbm,
                    vt_diag.ri
                );
            }

            if let Ok(mut statuses) = status_map.lock() {
                if let Some(entry) = statuses.get_mut(&session_id_owned) {
                    *entry = new_status.clone();
                }
            }

            sink.on_status(&session_id_owned, new_status);
        });

        let session = Arc::new(Mutex::new(PtySession {
            writer,
            controller,
            child,
            diagnostics,
            reader_handle: Some(reader_handle),
            created_at: Instant::now(),
            missing_since: None,
        }));
        self.sessions
            .write()
            .unwrap()
            .insert(session_id.to_string(), session);
        info!("pty session ready: id={}", session_id);
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let session_arc = {
            let sessions = self.sessions.read().unwrap();
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| {
            let msg = format!("Session {session_id} not found");
            error!("pty write failed: {}", msg);
            msg
        })?;
        let mut session = session_arc.lock().unwrap();
        session.writer.write_all(data.as_bytes()).map_err(|e| {
            error!("pty write failed: session_id={}, error={}", session_id, e);
            e.to_string()
        })?;
        session.writer.flush().map_err(|e| {
            error!("pty flush failed: session_id={}, error={}", session_id, e);
            e.to_string()
        })?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session_arc = {
            let sessions = self.sessions.read().unwrap();
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| {
            let msg = format!("Session {session_id} not found");
            error!("pty resize failed: {}", msg);
            msg
        })?;
        let session = session_arc.lock().unwrap();
        let cols = cols.max(MIN_PTY_COLS);
        let rows = rows.max(MIN_PTY_ROWS);
        debug!(
            "pty resize: session_id={}, cols={}, rows={}",
            session_id, cols, rows
        );
        if let Ok(mut diagnostics) = session.diagnostics.lock() {
            diagnostics.last_resize_cols = Some(cols);
            diagnostics.last_resize_rows = Some(rows);
        }
        session.controller.resize(cols, rows).map_err(|e| {
            error!("pty resize failed: session_id={}, error={}", session_id, e);
            e
        })
    }

    fn close_session_arc(session_id: &str, session_arc: Arc<Mutex<PtySession>>, reason: &str) {
        // Kill child first, take reader handle out, then drop the Arc.
        // Dropping the last Arc releases the master PTY, which causes the
        // reader thread to observe EOF and exit promptly.
        let (reader_handle, diagnostics) = {
            let mut session = session_arc.lock().unwrap();
            let diagnostics = session.diagnostics.lock().unwrap().clone();
            let child = Arc::clone(&session.child);
            #[cfg(target_os = "windows")]
            {
                let pid = child.process_id();
                if let Err(err) = Self::kill_process_tree(pid) {
                    warn!(
                        "pty process tree kill failed, fallback to child kill: id={}, pid={}, reason={}, error={}",
                        session_id, pid, reason, err
                    );
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let pid = child.process_id();
                if let Err(err) = Self::kill_process_group(pid) {
                    warn!(
                        "pty process group kill failed, fallback to child kill: id={}, pid={}, reason={}, error={}",
                        session_id, pid, reason, err
                    );
                }
            }
            let _ = child.kill();
            (session.reader_handle.take(), diagnostics)
        };
        drop(session_arc);
        if let Some(handle) = reader_handle {
            let _ = handle.join();
        }
        info!(
            "pty session killed: id={}, reason={}, shell={}, exe={}, cwd={:?}",
            session_id, reason, diagnostics.shell, diagnostics.exe, diagnostics.cwd
        );
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let session_arc = {
            let mut sessions = self.sessions.write().unwrap();
            sessions.remove(session_id)
        };
        if let Some(session_arc) = session_arc {
            Self::close_session_arc(session_id, session_arc, "close");
        } else {
            debug!("pty close requested for missing session: id={}", session_id);
        }
        self.statuses.lock().unwrap().remove(session_id);
        Ok(())
    }

    pub fn reconcile_active_sessions(
        &self,
        active_session_ids: Vec<String>,
    ) -> PtyOrphanCleanupSummary {
        let active_ids: HashSet<String> = active_session_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect();
        let active_count = active_ids.len();
        let create_grace = Duration::from_secs(ORPHAN_CREATE_GRACE_SECS);
        let missing_grace = Duration::from_secs(ORPHAN_MISSING_GRACE_SECS);

        if active_ids.is_empty() {
            let tracked_count = self.sessions.read().unwrap().len();
            debug!(
                "pty orphan reconcile skipped: active list empty, tracked={}",
                tracked_count
            );
            return PtyOrphanCleanupSummary {
                active_count,
                tracked_count,
                marked_missing: 0,
                protected_count: 0,
                cleaned_count: 0,
                skipped_empty_active_list: true,
            };
        }

        let now = Instant::now();
        let mut marked_missing = 0usize;
        let mut protected_count = 0usize;
        let mut sessions_to_close: Vec<(String, Arc<Mutex<PtySession>>)> = Vec::new();
        let tracked_count;

        {
            let mut sessions = self.sessions.write().unwrap();
            tracked_count = sessions.len();
            let session_ids: Vec<String> = sessions.keys().cloned().collect();

            for session_id in session_ids {
                if active_ids.contains(&session_id) {
                    if let Some(session_arc) = sessions.get(&session_id) {
                        let mut session = session_arc.lock().unwrap();
                        if session.missing_since.take().is_some() {
                            debug!("pty orphan candidate recovered: id={}", session_id);
                        }
                    }
                    continue;
                }

                let mut should_close = false;
                if let Some(session_arc) = sessions.get(&session_id) {
                    let mut session = session_arc.lock().unwrap();
                    let age = now.saturating_duration_since(session.created_at);
                    if age < create_grace {
                        protected_count += 1;
                        debug!(
                            "pty orphan reconcile protected new session: id={}, age_secs={}",
                            session_id,
                            age.as_secs()
                        );
                        continue;
                    }

                    if let Some(missing_since) = session.missing_since {
                        let missing_for = now.saturating_duration_since(missing_since);
                        if missing_for >= missing_grace {
                            should_close = true;
                        } else {
                            protected_count += 1;
                            debug!(
                                "pty orphan reconcile waiting grace: id={}, missing_secs={}",
                                session_id,
                                missing_for.as_secs()
                            );
                        }
                    } else {
                        let diagnostics = session.diagnostics.lock().unwrap().clone();
                        session.missing_since = Some(now);
                        marked_missing += 1;
                        info!(
                            "pty orphan candidate marked missing: id={}, age_secs={}, active_count={}, tracked_count={}, shell={}, exe={}, cwd={:?}",
                            session_id,
                            age.as_secs(),
                            active_count,
                            tracked_count,
                            diagnostics.shell,
                            diagnostics.exe,
                            diagnostics.cwd
                        );
                    }
                }

                if should_close {
                    if let Some(session_arc) = sessions.remove(&session_id) {
                        sessions_to_close.push((session_id, session_arc));
                    }
                }
            }
        }

        let cleaned_count = sessions_to_close.len();
        for (session_id, session_arc) in sessions_to_close {
            warn!(
                "pty orphan cleanup closing missing session: id={}",
                session_id
            );
            Self::close_session_arc(&session_id, session_arc, "orphan_reconcile");
            self.statuses.lock().unwrap().remove(&session_id);
        }

        PtyOrphanCleanupSummary {
            active_count,
            tracked_count,
            marked_missing,
            protected_count,
            cleaned_count,
            skipped_empty_active_list: false,
        }
    }

    /// 应用退出路径的批量关闭（Windows）：单次写锁取出全部会话 → 收集 PID 一次性
    /// taskkill 全部进程树 → 逐会话 child.kill() 兜底并释放 master → 统一 join reader。
    /// 单会话 `close()`（手动关 Tab 路径）保持不变。
    #[cfg(target_os = "windows")]
    pub fn close_all(&self) -> Result<(), String> {
        let sessions: Vec<(String, Arc<Mutex<PtySession>>)> = {
            let mut map = self.sessions.write().unwrap();
            map.drain().collect()
        };
        if sessions.is_empty() {
            self.statuses.lock().unwrap().clear();
            return Ok(());
        }

        let pids: Vec<u32> = sessions
            .iter()
            .map(|(_, session_arc)| {
                let session = session_arc.lock().unwrap();
                session.child.process_id()
            })
            .collect();
        if let Err(err) = Self::kill_process_trees(&pids) {
            warn!(
                "pty batch process tree kill failed, fallback to per-child kill: pids={:?}, error={}",
                pids, err
            );
        }

        // child.kill() 兜底 + 取出 reader handle；drop 最后一个 session Arc 释放 master，
        // 让 reader 线程观察到 EOF（与单会话 close 的释放语义一致）。
        let mut reader_handles: Vec<(String, JoinHandle<()>)> = Vec::with_capacity(sessions.len());
        for (session_id, session_arc) in sessions {
            let reader_handle = {
                let mut session = session_arc.lock().unwrap();
                let _ = session.child.kill();
                session.reader_handle.take()
            };
            drop(session_arc);
            if let Some(handle) = reader_handle {
                reader_handles.push((session_id, handle));
            } else {
                info!("pty session killed (close_all): id={}", session_id);
            }
        }

        let closed = reader_handles.len();
        for (session_id, handle) in reader_handles {
            let _ = handle.join();
            info!("pty session killed (close_all): id={}", session_id);
        }
        info!(
            "pty close_all: batch closed sessions, joined_readers={}",
            closed
        );

        self.statuses.lock().unwrap().clear();
        Ok(())
    }

    /// 非 Windows：无批量 taskkill 需求，维持逐个 close 的既有行为。
    #[cfg(not(target_os = "windows"))]
    pub fn close_all(&self) -> Result<(), String> {
        let session_ids: Vec<String> = self.sessions.read().unwrap().keys().cloned().collect();
        for session_id in session_ids {
            self.close(&session_id)?;
        }
        Ok(())
    }

    pub fn status_all(&self) -> HashMap<String, PtyProcessStatus> {
        self.statuses.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    struct TestPtySink {
        output: Arc<Mutex<Vec<u8>>>,
    }

    #[cfg(target_os = "windows")]
    impl PtyEventSink for TestPtySink {
        fn on_output(&self, _session_id: &str, data: &[u8]) {
            self.output.lock().unwrap().extend_from_slice(data);
        }

        fn on_status(&self, _session_id: &str, _status: PtyProcessStatus) {}
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn direct_conpty_can_spawn_write_and_read_cmd() {
        let manager = PtyManager::new();
        let output = Arc::new(Mutex::new(Vec::new()));
        manager
            .create(
                "conpty-test",
                None,
                None,
                Some("cmd"),
                Arc::new(TestPtySink {
                    output: Arc::clone(&output),
                }),
            )
            .unwrap();
        manager.resize("conpty-test", 120, 30).unwrap();
        manager
            .write("conpty-test", "echo CLI_MANAGER_CONPTY_OK\r\n")
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let text = String::from_utf8_lossy(&output.lock().unwrap()).to_string();
            if text.contains("CLI_MANAGER_CONPTY_OK") {
                manager.close("conpty-test").unwrap();
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let captured = String::from_utf8_lossy(&output.lock().unwrap()).to_string();
        manager.close("conpty-test").unwrap();
        panic!("ConPTY output marker not received: {captured:?}");
    }

    #[test]
    fn reconcile_active_sessions_skips_empty_active_list() {
        let manager = PtyManager::new();

        let summary = manager.reconcile_active_sessions(Vec::new());

        assert!(summary.skipped_empty_active_list);
        assert_eq!(summary.active_count, 0);
        assert_eq!(summary.tracked_count, 0);
        assert_eq!(summary.cleaned_count, 0);
    }

    #[test]
    fn reconcile_active_sessions_handles_no_tracked_sessions() {
        let manager = PtyManager::new();

        let summary = manager.reconcile_active_sessions(vec!["session-1".to_string()]);

        assert!(!summary.skipped_empty_active_list);
        assert_eq!(summary.active_count, 1);
        assert_eq!(summary.tracked_count, 0);
        assert_eq!(summary.cleaned_count, 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_shell_args_starts_zsh_as_login_shell_on_macos() {
        let (exe, args) = PtyManager::build_shell_args("zsh", None).unwrap();

        assert_eq!(exe, "zsh");
        assert_eq!(args, vec!["-l".to_string()]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_shell_args_starts_bash_as_login_shell_on_macos() {
        let (exe, args) = PtyManager::build_shell_args("bash", None).unwrap();

        assert_eq!(exe, "bash");
        assert_eq!(args, vec!["--login".to_string(), "-i".to_string()]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_shell_launch_log_context_marks_login_shell_details_on_macos() {
        let (exe, args) = PtyManager::build_shell_args("zsh", None).unwrap();

        let context = PtyManager::build_shell_launch_log_context(
            Some("zsh"),
            "zsh",
            &exe,
            &args,
            Some("/tmp/project"),
        );

        assert_eq!(context.requested_shell, Some("zsh".to_string()));
        assert_eq!(context.shell_key, "zsh");
        assert_eq!(context.exe, "zsh");
        assert_eq!(context.args, vec!["-l".to_string()]);
        assert!(context.login_shell);
        assert_eq!(context.cwd, Some("/tmp/project".to_string()));
    }

    #[test]
    fn wsl_env_forwarding_adds_callback_vars_and_keeps_existing() {
        let mut vars = HashMap::new();
        vars.insert("CLI_MANAGER_TAB_ID".to_string(), "t".to_string());
        vars.insert("CLI_MANAGER_NOTIFY_PORT".to_string(), "1".to_string());
        vars.insert("CLI_MANAGER_NOTIFY_TOKEN".to_string(), "x".to_string());
        // 预置 WSLENV，函数应合并而非覆盖（也避免读到进程环境，保证确定性）
        vars.insert("WSLENV".to_string(), "FOO/u".to_string());

        PtyManager::apply_wsl_env_forwarding(&mut vars);

        let wslenv = vars.get("WSLENV").unwrap();
        assert!(wslenv.contains("FOO/u"));
        assert!(wslenv.contains("CLI_MANAGER_TAB_ID"));
        assert!(wslenv.contains("CLI_MANAGER_NOTIFY_PORT"));
        assert!(wslenv.contains("CLI_MANAGER_NOTIFY_TOKEN"));
    }

    #[test]
    fn wsl_env_forwarding_is_noop_without_callback_vars() {
        let mut vars = HashMap::new();
        vars.insert("WSLENV".to_string(), "FOO/u".to_string());
        PtyManager::apply_wsl_env_forwarding(&mut vars);
        // 无回调变量时不应改动 WSLENV
        assert_eq!(vars.get("WSLENV").unwrap(), "FOO/u");
    }

    #[test]
    fn wsl_env_forwarding_no_duplicate_when_already_listed() {
        let mut vars = HashMap::new();
        vars.insert("CLI_MANAGER_TAB_ID".to_string(), "t".to_string());
        vars.insert("WSLENV".to_string(), "CLI_MANAGER_TAB_ID".to_string());
        PtyManager::apply_wsl_env_forwarding(&mut vars);
        assert_eq!(vars.get("WSLENV").unwrap(), "CLI_MANAGER_TAB_ID");
    }

    #[test]
    fn vt_diag_counts_scroll_related_sequences() {
        let mut diag = VtScrollDiag::default();
        let data = b"\x1b[?1049hhello\x1b[2J\x1b[3J\x1b[1;24r\x1bMworld\x1b[2J\x1b[?1049l";
        scan_vt_scroll_sequences(data, &mut diag, "test");
        assert_eq!(diag.alt_enter, 1);
        assert_eq!(diag.alt_exit, 1);
        assert_eq!(diag.ed2, 2);
        assert_eq!(diag.ed3, 1);
        assert_eq!(diag.decstbm, 1);
        assert_eq!(diag.ri, 1);
    }

    #[test]
    fn vt_diag_ignores_unrelated_sequences() {
        let mut diag = VtScrollDiag::default();
        // 光标隐藏、SGR、ED0、DEC 私有模式 restore（? 前缀的 r）、DECSCUSR 都不应计入
        let data = b"\x1b[?25l\x1b[0m\x1b[J\x1b[?1000r\x1b[2 qplain text";
        scan_vt_scroll_sequences(data, &mut diag, "test");
        assert_eq!(diag.alt_enter, 0);
        assert_eq!(diag.alt_exit, 0);
        assert_eq!(diag.ed2, 0);
        assert_eq!(diag.ed3, 0);
        assert_eq!(diag.decstbm, 0);
        assert_eq!(diag.ri, 0);
    }

    #[test]
    fn vt_diag_counts_full_screen_decstbm_reset() {
        let mut diag = VtScrollDiag::default();
        scan_vt_scroll_sequences(b"\x1b[r", &mut diag, "test");
        assert_eq!(diag.decstbm, 1);
    }

    #[test]
    fn resolve_shell_accepts_custom_executable_path() {
        let path = std::env::temp_dir().join(format!(
            "cli-manager-test-shell-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, b"test").unwrap();

        let (exe, args) = PtyManager::resolve_shell(path.to_str().unwrap()).unwrap();

        assert_eq!(exe, path.to_string_lossy().to_string());
        assert!(args.is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn resolve_shell_rejects_missing_custom_path() {
        let missing = std::env::temp_dir().join("cli-manager-missing-shell.exe");
        let result = PtyManager::resolve_shell(missing.to_str().unwrap());

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Shell executable not found"));
    }
}
