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
fn trimmed_startup_cmd(tab: &ExternalTab) -> Option<&str> {
    tab.startup_cmd
        .as_deref()
        .map(str::trim)
        .filter(|cmd| !cmd.is_empty())
}

#[cfg(target_os = "windows")]
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
fn escape_posix_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(not(target_os = "windows"))]
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
fn build_unix_terminal_command(tab: &ExternalTab) -> String {
    let shell = unix_shell_exe(tab.shell.as_deref());
    let mut parts: Vec<String> = Vec::new();
    if let Some(cwd) = tab
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
    {
        parts.push(format!("cd {}", escape_posix_single_quoted(cwd)));
    }
    if let Some(cmd) = trimmed_startup_cmd(tab) {
        parts.push(cmd.to_string());
    }
    parts.push(format!("exec {}", escape_posix_single_quoted(&shell)));
    parts.join("; ")
}

#[cfg(target_os = "macos")]
fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "windows")]
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
pub async fn open_windows_terminal(tabs: Vec<ExternalTab>) -> Result<(), String> {
    open_platform_terminal(&tabs)
}

/// 在系统文件管理器中打开指定路径
#[tauri::command]
pub async fn open_folder_in_explorer(path: String, open_file: Option<bool>) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);

    // 检查路径是否存在
    if !path_buf.exists() {
        return Err(format!("路径不存在: {}", path));
    }

    // Windows 上使用 explorer 打开
    #[cfg(target_os = "windows")]
    {
        let result = if path_buf.is_file() && open_file.unwrap_or(false) {
            Command::new("explorer").arg(&path).spawn()
        } else if path_buf.is_file() {
            // 如果是文件，使用 /select 参数在文件管理器中选中该文件
            Command::new("explorer").args(&["/select,", &path]).spawn()
        } else {
            // 如果是目录，直接打开
            Command::new("explorer").arg(&path).spawn()
        };

        result.map_err(|e| {
            error!("Failed to open folder in explorer: {}", e);
            format!("无法打开文件夹: {}", e)
        })?;

        debug!("Opened folder in explorer: {}", path);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if path_buf.is_file() {
            command.arg("-R").arg(&path);
        } else {
            command.arg(&path);
        }
        command.spawn().map_err(|e| {
            error!("Failed to open path in Finder: {}", e);
            format!("无法打开文件夹: {}", e)
        })?;

        debug!("Opened path in Finder: {}", path);
        Ok(())
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let target = if path_buf.is_file() {
            path_buf.parent().unwrap_or(&path_buf)
        } else {
            path_buf.as_path()
        };
        Command::new("xdg-open").arg(target).spawn().map_err(|e| {
            error!("Failed to open path with xdg-open: {}", e);
            format!("无法打开文件夹: {}", e)
        })?;

        debug!("Opened path with xdg-open: {}", target.to_string_lossy());
        Ok(())
    }
}
