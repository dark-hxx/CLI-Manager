use log::{debug, error};
#[cfg(target_os = "windows")]
use std::io::ErrorKind;
use std::path::PathBuf;
use std::process::Command;

#[cfg(target_os = "windows")]
use crate::shell_resolver::{resolve_git_bash_exe, GIT_BASH_NOT_FOUND_MESSAGE};

#[derive(serde::Deserialize)]
pub struct ExternalTab {
    pub cwd: Option<String>,
    #[cfg(target_os = "windows")]
    pub title: String,
    pub startup_cmd: Option<String>,
    pub shell: Option<String>,
}

#[cfg(target_os = "windows")]
// 含路径分隔符的 shell 字符串按自定义文件检查，存在则返回原修剪路径；不含分隔符视为内置键。
fn resolve_custom_shell_path(shell: &str) -> Result<Option<String>, String> {
    let trimmed = shell.trim();
    let looks_like_path = trimmed.contains('\\') || trimmed.contains('/');
    if !looks_like_path {
        return Ok(None);
    }
    let path = PathBuf::from(trimmed);
    if path.is_file() {
        return Ok(Some(trimmed.to_string()));
    }
    Err(format!("Shell executable not found: {trimmed}"))
}

#[cfg(target_os = "windows")]
// Windows 优先解析自定义 shell 路径，否则映射内置 shell 与保持窗口参数，未知键默认 PowerShell。
fn shell_exe(shell: &str) -> Result<(String, Option<&'static str>), String> {
    if let Some(custom_shell) = resolve_custom_shell_path(shell)? {
        return Ok((custom_shell, None));
    }
    match shell {
        // Windows shells
        "cmd" => Ok(("cmd".to_string(), Some("/K"))),
        "pwsh" => Ok(("pwsh".to_string(), Some("-NoExit"))),
        "wsl" => Ok(("wsl".to_string(), None)),
        "gitbash" => resolve_git_bash_exe()
            .map(|path| (path.to_string_lossy().into_owned(), None))
            .ok_or_else(|| GIT_BASH_NOT_FOUND_MESSAGE.to_string()),
        // Unix shells (these won't be invoked on Windows Terminal, but safe to define)
        "zsh" => Ok(("zsh".to_string(), None)),
        "fish" => Ok(("fish".to_string(), None)),
        "sh" => Ok(("sh".to_string(), None)),
        "bash" => Ok(("bash".to_string(), None)),
        // Default: powershell on Windows
        _ => Ok(("powershell".to_string(), Some("-NoExit"))),
    }
}

#[cfg(not(target_os = "windows"))]
// 取得去除首尾空白后的非空启动命令，不解析或转义其内容。
fn trimmed_startup_cmd(tab: &ExternalTab) -> Option<&str> {
    tab.startup_cmd
        .as_deref()
        .map(str::trim)
        .filter(|cmd| !cmd.is_empty())
}

#[cfg(target_os = "windows")]
// 向 Windows Terminal 参数追加目录、标题和 shell；启动命令按 cmd、Git Bash、自定义 shell 或其他 shell 分支组装。
fn push_tab_args(args: &mut Vec<String>, tab: &ExternalTab) -> Result<(), String> {
    args.push("new-tab".into());
    if let Some(cwd) = &tab.cwd {
        args.push("-d".into());
        args.push(cwd.clone());
    }
    args.push("--title".into());
    args.push(tab.title.clone());
    args.push("--suppressApplicationTitle".into());

    let shell_key = tab.shell.as_deref().unwrap_or("powershell");
    let (exe, no_exit_flag) = shell_exe(shell_key)?;
    let custom_shell = resolve_custom_shell_path(shell_key)?.is_some();

    if let Some(cmd) = &tab.startup_cmd {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            args.push(exe.into());
            if let Some(flag) = no_exit_flag {
                args.push(flag.into());
            }
            if shell_key == "cmd" {
                args.push(cmd.into());
            } else if shell_key == "gitbash" {
                args.push("--login".into());
                args.push("-i".into());
                args.push("-c".into());
                args.push(format!("{}; exec bash --login -i", cmd));
            } else if custom_shell {
                args.push(cmd.into());
            } else {
                args.push("-Command".into());
                args.push(cmd.into());
            }
            return Ok(());
        }
    }
    args.push(exe.into());
    Ok(())
}

#[cfg(not(target_os = "windows"))]
// 将字符串包裹为 POSIX 单引号参数，并拆分转义内部单引号。
fn escape_posix_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(not(target_os = "windows"))]
// 选择支持的 Unix shell 或存在的自定义路径，未知值在 macOS 默认 zsh、其他平台默认 bash。
fn unix_shell_exe(shell: Option<&str>) -> String {
    match shell {
        Some("bash") => "bash".to_string(),
        Some("zsh") => "zsh".to_string(),
        Some("fish") => "fish".to_string(),
        Some("sh") => "sh".to_string(),
        Some("pwsh") => "pwsh".to_string(),
        Some(value) if value.contains('/') && PathBuf::from(value).is_file() => value.to_string(),
        _ if cfg!(target_os = "macos") => "zsh".to_string(),
        _ => "bash".to_string(),
    }
}

#[cfg(not(target_os = "windows"))]
// 顺序拼接可选 cd、原样启动命令与 exec shell，以分号连接，因此 cd 失败不会自动阻止后续命令。
fn build_unix_terminal_command(tab: &ExternalTab) -> String {
    let shell = unix_shell_exe(tab.shell.as_deref());
    let cwd = tab
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty());
    let startup = trimmed_startup_cmd(tab);
    let setup = match (cwd, startup) {
        (Some(cwd), Some(cmd)) => {
            format!("cd {} && {cmd}", escape_posix_single_quoted(cwd))
        }
        (Some(cwd), None) => format!("cd {}", escape_posix_single_quoted(cwd)),
        (None, Some(cmd)) => cmd.to_string(),
        (None, None) => String::new(),
    };
    let launch_shell = format!("exec {}", escape_posix_single_quoted(&shell));
    if setup.is_empty() {
        launch_shell
    } else {
        format!("{setup}; {launch_shell}")
    }
}

#[cfg(target_os = "macos")]
// 转义 AppleScript 字符串中的反斜杠和双引号。
fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "windows")]
// 依次生成 wt、wt.exe 及 LOCALAPPDATA 下应用执行别名候选路径，不检查存在性。
fn windows_terminal_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("wt"), PathBuf::from("wt.exe")];
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Microsoft")
                .join("WindowsApps")
                .join("wt.exe"),
        );
    }
    candidates
}

#[cfg(target_os = "windows")]
// 依次尝试启动 Windows Terminal 候选，首次 spawn 成功即返回；全部失败返回最后错误，不等待终端退出。
fn spawn_windows_terminal(args: &[String]) -> Result<PathBuf, std::io::Error> {
    let candidates = windows_terminal_candidates();
    let mut last_err: Option<std::io::Error> = None;

    for candidate in candidates {
        match Command::new(&candidate).args(args).spawn() {
            Ok(_) => return Ok(candidate),
            Err(err) => {
                log::warn!("Failed to spawn {:?}: {}", candidate, err);
                last_err = Some(err);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            ErrorKind::NotFound,
            "Windows Terminal executable (wt.exe) not found",
        )
    }))
}

#[cfg(target_os = "windows")]
// 将全部标签参数交给 Windows Terminal 的零号窗口，找不到程序时返回安装或设置提示。
fn open_platform_terminal(tabs: &[ExternalTab]) -> Result<(), String> {
    if tabs.is_empty() {
        return Ok(());
    }

    let mut args: Vec<String> = vec!["-w".into(), "0".into()];
    for (i, tab) in tabs.iter().enumerate() {
        if i > 0 {
            args.push(";".into());
        }
        push_tab_args(&mut args, tab).map_err(|e| {
            error!(
                "Failed to resolve shell for Windows Terminal tab: shell={:?}, error={}",
                tab.shell, e
            );
            e
        })?;
    }

    debug!("open_windows_terminal: tabs={}", tabs.len());

    spawn_windows_terminal(&args).map_err(|e| {
        error!("Failed to open Windows Terminal: {}", e);
        if e.kind() == ErrorKind::NotFound {
            "Failed to open Windows Terminal: Windows Terminal (wt.exe) not found. Please install Windows Terminal or disable external terminal mode in Settings.".to_string()
        } else {
            format!("Failed to open Windows Terminal: {}", e)
        }
    })?;

    Ok(())
}

#[cfg(target_os = "macos")]
// 逐标签通过 AppleScript 激活 Terminal.app 并执行命令，等待 osascript 成功；后续失败不关闭已打开标签。
fn open_platform_terminal(tabs: &[ExternalTab]) -> Result<(), String> {
    if tabs.is_empty() {
        return Ok(());
    }

    for tab in tabs {
        let command = escape_applescript_string(&build_unix_terminal_command(tab));
        let do_script = format!("do script \"{command}\"");
        let status = Command::new("osascript")
            .args([
                "-e",
                "tell application \"Terminal\"",
                "-e",
                "activate",
                "-e",
                &do_script,
                "-e",
                "end tell",
            ])
            .status()
            .map_err(|e| {
                error!("Failed to open Terminal.app: {}", e);
                format!("无法打开外部终端: {}", e)
            })?;
        if !status.success() {
            return Err(format!("无法打开外部终端: osascript exited with {status}"));
        }
    }

    debug!("open_external_terminal: Terminal.app tabs={}", tabs.len());
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
// 逐标签依次尝试五种终端模拟器，首次进程启动成功即停止尝试；失败不回滚此前已打开终端。
fn open_platform_terminal(tabs: &[ExternalTab]) -> Result<(), String> {
    if tabs.is_empty() {
        return Ok(());
    }

    for tab in tabs {
        let command = build_unix_terminal_command(tab);
        let candidates: Vec<(&str, Vec<String>)> = vec![
            (
                "x-terminal-emulator",
                vec!["-e".into(), "sh".into(), "-lc".into(), command.clone()],
            ),
            (
                "gnome-terminal",
                vec!["--".into(), "sh".into(), "-lc".into(), command.clone()],
            ),
            (
                "konsole",
                vec!["-e".into(), "sh".into(), "-lc".into(), command.clone()],
            ),
            (
                "xfce4-terminal",
                vec!["-x".into(), "sh".into(), "-lc".into(), command.clone()],
            ),
            (
                "xterm",
                vec!["-e".into(), "sh".into(), "-lc".into(), command],
            ),
        ];
        let mut last_err: Option<std::io::Error> = None;
        let mut opened = false;
        for (program, args) in candidates {
            match Command::new(program).args(&args).spawn() {
                Ok(_) => {
                    opened = true;
                    break;
                }
                Err(err) => {
                    log::warn!("Failed to spawn {}: {}", program, err);
                    last_err = Some(err);
                }
            }
        }
        if !opened {
            let detail = last_err
                .map(|err| err.to_string())
                .unwrap_or_else(|| "no supported terminal found".to_string());
            return Err(format!("无法打开外部终端: {detail}"));
        }
    }

    debug!("open_external_terminal: linux tabs={}", tabs.len());
    Ok(())
}

#[tauri::command]
// 保留历史 IPC 名称，按当前平台分派外部终端启动。
pub async fn open_windows_terminal(tabs: Vec<ExternalTab>) -> Result<(), String> {
    open_platform_terminal(&tabs)
}

#[cfg(target_os = "windows")]
// 按前三字节识别盘符、冒号和路径分隔符组成的 Windows 绝对盘符路径。
fn is_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

#[cfg(target_os = "windows")]
// 去除盘符路径多余前导斜杠并统一反斜杠，规范化 WSL UNC，其余路径仅去除首尾空白。
fn normalize_windows_explorer_path(path: &str) -> String {
    let trimmed = path.trim();
    let path = match trimmed.strip_prefix('/') {
        Some(candidate) if is_windows_drive_path(candidate) => candidate,
        _ => trimmed,
    };

    if is_windows_drive_path(path) {
        return path.replace('/', "\\");
    }

    if crate::wsl::is_wsl_config_dir(path) {
        return crate::wsl::normalize_wsl_unc_path(path);
    }

    path.to_string()
}

/// 在系统文件管理器中打开指定路径
#[tauri::command]
// 检查路径存在后调用系统文件管理器；Windows 按 open_file 决定打开或选中，macOS 定位文件，其他平台打开父目录。
pub async fn open_folder_in_explorer(path: String, open_file: Option<bool>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let system_path = normalize_windows_explorer_path(&path);
    #[cfg(not(target_os = "windows"))]
    let system_path = path.clone();
    let path_buf = PathBuf::from(&system_path);

    // 检查路径是否存在
    if !path_buf.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    // Windows 上使用 explorer 打开
    #[cfg(target_os = "windows")]
    {
        let result = if path_buf.is_file() && open_file.unwrap_or(false) {
            Command::new("explorer").arg(&system_path).spawn()
        } else if path_buf.is_file() {
            // 如果是文件，使用 /select 参数在文件管理器中选中该文件
            Command::new("explorer")
                .args(["/select,", system_path.as_str()])
                .spawn()
        } else {
            // 如果是目录，直接打开
            Command::new("explorer").arg(&system_path).spawn()
        };

        result.map_err(|e| {
            error!("Failed to open folder in explorer: {}", e);
            format!("无法打开文件夹: {}", e)
        })?;

        debug!("Opened folder in explorer: {}", system_path);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        let open_with_default_app = path_buf.is_file() && open_file.unwrap_or(false);
        if path_buf.is_file() && !open_with_default_app {
            command.arg("-R").arg(&path);
        } else {
            command.arg(&path);
        }
        command.spawn().map_err(|e| {
            error!("Failed to open path in Finder: {}", e);
            format!(
                "{}: {}",
                if open_with_default_app {
                    "无法打开文件"
                } else {
                    "无法打开文件夹"
                },
                e
            )
        })?;

        debug!("Opened path in Finder: {}", path);
        Ok(())
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let open_with_default_app = path_buf.is_file() && open_file.unwrap_or(false);
        let target = if path_buf.is_file() && !open_with_default_app {
            path_buf.parent().unwrap_or(&path_buf)
        } else {
            path_buf.as_path()
        };
        Command::new("xdg-open").arg(target).spawn().map_err(|e| {
            error!("Failed to open path with xdg-open: {}", e);
            format!(
                "{}: {}",
                if open_with_default_app {
                    "无法打开文件"
                } else {
                    "无法打开文件夹"
                },
                e
            )
        })?;

        debug!("Opened path with xdg-open: {}", target.to_string_lossy());
        Ok(())
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::normalize_windows_explorer_path;

    #[test]
    // 验证带多余前导斜杠、正斜杠与原生反斜杠的盘符路径归一结果一致。
    fn normalize_windows_explorer_path_normalizes_drive_paths() {
        assert_eq!(
            normalize_windows_explorer_path(
                "/F:/github/smart-home/demo3/knx-workspace/initial-quote-v1/project.knxproj"
            ),
            r"F:\github\smart-home\demo3\knx-workspace\initial-quote-v1\project.knxproj"
        );
        assert_eq!(
            normalize_windows_explorer_path("F:/github/smart-home/project.knxproj"),
            r"F:\github\smart-home\project.knxproj"
        );
        assert_eq!(
            normalize_windows_explorer_path(r"F:\github\smart-home\project.knxproj"),
            r"F:\github\smart-home\project.knxproj"
        );
    }

    #[test]
    // 验证普通 UNC 保持不变，带 verbatim 前缀的 WSL UNC 转为标准形式。
    fn normalize_windows_explorer_path_preserves_unc_and_normalizes_wsl_unc() {
        assert_eq!(
            normalize_windows_explorer_path(r"\\server\share\project.knxproj"),
            r"\\server\share\project.knxproj"
        );
        assert_eq!(
            normalize_windows_explorer_path(
                r"\\?\UNC\wsl.localhost\Ubuntu\home\me\project.knxproj"
            ),
            r"\\wsl.localhost\Ubuntu\home\me\project.knxproj"
        );
    }
}
