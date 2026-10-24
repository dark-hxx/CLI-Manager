use std::collections::VecDeque;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};

const MAX_PENDING_OPEN_TERMINAL_REQUESTS: usize = 32;

#[derive(Default)]
pub(crate) struct PendingOpenTerminalRequests(pub(crate) Mutex<VecDeque<String>>);

pub(crate) struct EnqueueResult {
    pub(crate) accepted: Vec<String>,
    pub(crate) dropped: usize,
}

pub(crate) fn parse_open_terminal_args(args: &[String]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].trim();
        if let Some(value) = arg.strip_prefix("--open-terminal=") {
            if !value.trim().is_empty() {
                paths.push(value.to_string());
            }
        } else if arg == "--open-terminal" {
            if let Some(value) = args.get(index + 1) {
                if !value.trim().is_empty() {
                    paths.push(value.clone());
                }
                index += 1;
            }
        }
        index += 1;
    }
    paths
}

pub(crate) fn enqueue<R: Runtime>(
    app: &AppHandle<R>,
    paths: impl IntoIterator<Item = String>,
) -> EnqueueResult {
    let mut accepted = Vec::new();
    let mut dropped = 0;
    if let Ok(mut pending) = app.state::<PendingOpenTerminalRequests>().0.lock() {
        for path in paths {
            let path = path.trim().to_string();
            if path.is_empty() {
                continue;
            }
            if pending.len() >= MAX_PENDING_OPEN_TERMINAL_REQUESTS {
                dropped += 1;
                continue;
            }
            pending.push_back(path.clone());
            accepted.push(path);
        }
    }
    EnqueueResult { accepted, dropped }
}

pub(crate) fn emit_request_event<R: Runtime>(app: &AppHandle<R>, paths: &[String]) {
    if !paths.is_empty() {
        let _ = app.emit("open-terminal-requested", paths.to_vec());
    }
}

pub(crate) fn take_pending(
    pending: &PendingOpenTerminalRequests,
) -> Vec<String> {
    pending
        .0
        .lock()
        .map(|mut value| value.drain(..).collect())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
pub(crate) fn set_windows_explorer_context_menu(enabled: bool) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    fn notify_explorer() {
        // Explorer caches shell verbs; broadcast the association change so a
        // newly installed or toggled entry is visible without logging out.
        unsafe {
            windows_sys::Win32::UI::Shell::SHChangeNotify(
                windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
                windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }
    }

    const DIRECTORY_KEY: &str = "Software\\Classes\\Directory\\shell\\CLIManager";
    const BACKGROUND_KEY: &str = "Software\\Classes\\Directory\\Background\\shell\\CLIManager";
    const MENU_LABEL: &str = "Open CLI-Manager here";

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if !enabled {
        for key in [DIRECTORY_KEY, BACKGROUND_KEY] {
            match hkcu.delete_subkey_all(key) {
                Ok(()) => {}
                Err(error) if error.raw_os_error() == Some(2) => {}
                Err(error) => return Err(format!("failed to remove Explorer menu: {error}")),
            }
        }
        notify_explorer();
        return Ok(());
    }

    let executable = std::env::current_exe().map_err(|error| {
        format!("failed to locate CLI-Manager executable for Explorer menu: {error}")
    })?;
    let executable = executable.to_string_lossy().into_owned();
    let write_entry = |key_path: &str, placeholder: &str| -> Result<(), String> {
        let (key, _) = hkcu
            .create_subkey(key_path)
            .map_err(|error| format!("failed to create Explorer menu key: {error}"))?;
        // Keep a plain verb value alongside MUIVerb so Windows 11's modern
        // context-menu bridge can discover the legacy shell verb as well.
        key.set_value("", &MENU_LABEL)
            .map_err(|error| format!("failed to set Explorer menu verb: {error}"))?;
        key.set_value("MUIVerb", &MENU_LABEL)
            .map_err(|error| format!("failed to set Explorer menu label: {error}"))?;
        key.set_value("Icon", &executable)
            .map_err(|error| format!("failed to set Explorer menu icon: {error}"))?;
        let (command, _) = key.create_subkey("command").map_err(|error| {
            format!("failed to create Explorer menu command key: {error}")
        })?;
        let command_line = format!("\"{}\" --open-terminal \"{}\"", executable, placeholder);
        command
            .set_value("", &command_line)
            .map_err(|error| format!("failed to set Explorer menu command: {error}"))
    };

    write_entry(DIRECTORY_KEY, "%1")?;
    write_entry(BACKGROUND_KEY, "%V")?;
    notify_explorer();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn set_windows_explorer_context_menu(_enabled: bool) -> Result<(), String> {
    Err("Windows Explorer integration is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_open_terminal_args;

    #[test]
    fn parses_pair_and_equals_forms_without_splitting_paths() {
        let args = vec![
            "CLI-Manager.exe".into(),
            "--open-terminal".into(),
            r"C:\Users\测试 用户\repo".into(),
            r"--open-terminal=\\server\share\repo".into(),
        ];
        assert_eq!(
            parse_open_terminal_args(&args),
            vec![
                r"C:\Users\测试 用户\repo".to_string(),
                r"\\server\share\repo".to_string(),
            ]
        );
    }

    #[test]
    fn ignores_empty_values_and_unknown_arguments() {
        let args = vec![
            "--open-terminal".into(),
            "".into(),
            "--unknown".into(),
            "value".into(),
            "--open-terminal=".into(),
        ];
        assert!(parse_open_terminal_args(&args).is_empty());
    }
}
