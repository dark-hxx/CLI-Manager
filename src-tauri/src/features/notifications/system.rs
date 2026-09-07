use log::warn;
use notify_rust::NotificationResponse;
use serde::Serialize;
use std::{env, fs, process::Stdio};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const MAX_NOTIFICATION_TITLE_CHARS: usize = 200;
const MAX_NOTIFICATION_BODY_CHARS: usize = 1000;
const MAX_NOTIFICATION_ACTION_LABEL_CHARS: usize = 80;
const MAX_NOTIFICATION_TAB_ID_CHARS: usize = 200;
const SYSTEM_NOTIFICATION_ACTION_EVENT: &str = "system-notification-action";
const MIN_TASKBAR_FLASH_COUNT: u32 = 1;
const MAX_TASKBAR_FLASH_COUNT: u32 = 20;

#[cfg(target_os = "windows")]
const MAX_NOTIFICATION_SOUND_PATH_CHARS: usize = 32_767;
#[cfg(target_os = "windows")]
const MAX_NOTIFICATION_SOUND_FILE_BYTES: u64 = 20 * 1024 * 1024;
#[cfg(target_os = "windows")]
const WINDOWS_SILENT_SOUND_NAME: &str = "__cli_manager_silent__";

#[cfg(target_os = "windows")]
#[derive(Debug, PartialEq, Eq)]
struct TaskbarFlashParams {
    flags: u32,
    count: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemNotificationActionPayload {
    tab_id: String,
}

/// 检测当前是否运行在 WSL 环境中。
///
/// 优先检查 WSL 注入的环境变量，再读取 `/proc/version`，若包含
/// "microsoft" 或 "wsl" 关键字则判定为 WSL。若文件不存在或读取失败
/// （非 Linux），返回 false。
#[tauri::command]
pub fn is_wsl() -> bool {
    if cfg!(windows) {
        return false;
    }

    if env::var_os("WSL_DISTRO_NAME").is_some() || env::var_os("WSL_INTEROP").is_some() {
        return true;
    }

    fs::read_to_string("/proc/version")
        .map(|s| {
            let lower = s.to_lowercase();
            lower.contains("microsoft") || lower.contains("wsl")
        })
        .unwrap_or(false)
}

/// WSL 环境下通过 Windows 主机发送系统通知。
///
/// 使用 PowerShell + WinRT Toast API（Windows 原生），无需额外依赖。
/// 通知从 WSL 内调用 `powershell.exe`，桥接到 Windows 宿主的通知中心。
///
/// 注意：
/// - 标题和正文会做长度与 NUL 字符校验。
/// - 标题和正文中的 XML 特殊字符会自动转义。
/// - PowerShell 单引号会被转义（`'` → `''`）。
/// - 使用 `spawn()` 而非 `output()` 以避免阻塞调用者（异步发送）。
#[tauri::command]
pub async fn send_notification_via_windows(title: String, body: String) -> Result<(), String> {
    if !is_wsl() {
        return Err("windows_notification_bridge_requires_wsl".into());
    }

    validate_notification_title(&title)?;
    validate_notification_body(&body)?;

    let xml = format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text><text placement="attribution">来自 CLI-Manager</text></binding></visual></toast>"#,
        xml_escape(&title),
        xml_escape(&body)
    );

    let script = format!(
        r#"
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;
        $xml = [Windows.Data.Xml.Dom.XmlDocument]::new();
        $xml.LoadXml('{}');
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml);
        try {{
          $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.cli-manager.app');
          $notifier.Show($toast);
        }} catch {{
          [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('CLI-Manager').Show($toast);
        }}
        "#,
        xml.replace('\'', "''")
    );

    spawn_powershell_notification(&script)
}

/// 校验 Windows 本地 Hook 系统通知声音文件，不会播放声音。
#[tauri::command]
pub fn validate_system_notification_sound(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        resolve_notification_sound_path(&path).map(|_| ())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("notification_sound_windows_only".into())
    }
}

/// 试听 Windows 本地 Hook 系统通知声音。
#[tauri::command]
pub fn play_system_notification_sound(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let path = resolve_notification_sound_path(&path)?;
        play_windows_wav(&path)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("notification_sound_windows_only".into())
    }
}

#[tauri::command]
pub async fn send_interactive_system_notification(
    app: AppHandle,
    title: String,
    body: String,
    tab_id: String,
    action_label: String,
    custom_sound_path: Option<String>,
) -> Result<(), String> {
    validate_notification_title(&title)?;
    validate_notification_body(&body)?;
    validate_notification_text(
        &tab_id,
        MAX_NOTIFICATION_TAB_ID_CHARS,
        "notification_tab_id",
    )?;
    if tab_id.trim().is_empty() {
        return Err("notification_tab_id_empty".into());
    }
    validate_notification_text(
        &action_label,
        MAX_NOTIFICATION_ACTION_LABEL_CHARS,
        "notification_action_label",
    )?;
    if action_label.trim().is_empty() {
        return Err("notification_action_label_empty".into());
    }

    #[cfg(target_os = "windows")]
    let custom_sound_path =
        custom_sound_path
            .as_deref()
            .and_then(|path| match resolve_notification_sound_path(path) {
                Ok(path) => Some(path),
                Err(err) => {
                    warn!("custom system notification sound unavailable: {}", err);
                    None
                }
            });

    #[cfg(not(target_os = "windows"))]
    let _ = custom_sound_path;

    #[cfg(target_os = "windows")]
    let custom_sound_played =
        custom_sound_path
            .as_ref()
            .is_some_and(|path| match play_windows_wav(path) {
                Ok(()) => true,
                Err(err) => {
                    warn!("custom system notification sound playback failed: {}", err);
                    false
                }
            });

    let app_id = app.config().identifier.clone();
    let mut notification = notify_rust::Notification::new();
    notification
        .summary(&title)
        .body(&body)
        .appname("CLI-Manager")
        .auto_icon()
        .action("default", &action_label);

    #[cfg(target_os = "windows")]
    if custom_sound_played {
        // notify-rust exposes Windows sound names, not arbitrary local WAV paths.
        // An unknown name is converted to an explicit silent Toast audio element;
        // the validated file has already been queued through PlaySoundW above.
        notification.sound_name(WINDOWS_SILENT_SOUND_NAME);
    }

    #[cfg(target_os = "windows")]
    if should_use_registered_windows_app_id() {
        notification.app_id(&app_id);
    }

    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            app_id.as_str()
        });
    }

    let handle = notification
        .show()
        .map_err(|err| format!("notification_show_failed: {}", err))?;

    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(err) = handle.wait_for_response(|response: &NotificationResponse| {
            if matches!(
                response,
                NotificationResponse::Default | NotificationResponse::Action(_)
            ) {
                let payload = SystemNotificationActionPayload {
                    tab_id: tab_id.clone(),
                };
                if let Err(err) = app_handle.emit(SYSTEM_NOTIFICATION_ACTION_EVENT, payload) {
                    warn!("system notification action emit failed: {}", err);
                }
            }
        }) {
            warn!("system notification response wait failed: {}", err);
        }
    });

    Ok(())
}

#[cfg(target_os = "windows")]
fn resolve_notification_sound_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("notification_sound_path_empty".into());
    }
    if path.contains('\0') {
        return Err("notification_sound_path_contains_nul".into());
    }
    if path.encode_utf16().count() > MAX_NOTIFICATION_SOUND_PATH_CHARS {
        return Err("notification_sound_path_too_long".into());
    }

    let path = Path::new(path);
    let is_wav = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("wav"))
        .unwrap_or(false);
    if !is_wav {
        return Err("notification_sound_format_unsupported".into());
    }

    let canonical_path = path
        .canonicalize()
        .map_err(|_| "notification_sound_unavailable".to_string())?;
    let metadata =
        fs::metadata(&canonical_path).map_err(|_| "notification_sound_unavailable".to_string())?;
    if !metadata.is_file() {
        return Err("notification_sound_not_file".into());
    }
    if metadata.len() > MAX_NOTIFICATION_SOUND_FILE_BYTES {
        return Err("notification_sound_too_large".into());
    }

    let mut file = fs::File::open(&canonical_path)
        .map_err(|_| "notification_sound_unavailable".to_string())?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| "notification_sound_invalid_wave".to_string())?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("notification_sound_invalid_wave".into());
    }

    Ok(canonical_path)
}

#[cfg(target_os = "windows")]
fn custom_sound_play_flags() -> u32 {
    use windows_sys::Win32::Media::Audio::{SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

    SND_ASYNC | SND_FILENAME | SND_NODEFAULT
}

#[cfg(target_os = "windows")]
fn play_windows_wav(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Media::Audio::PlaySoundW;

    let wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        PlaySoundW(
            wide_path.as_ptr(),
            std::ptr::null_mut(),
            custom_sound_play_flags(),
        )
    };
    if result == 0 {
        return Err("notification_sound_play_failed".into());
    }
    Ok(())
}

#[tauri::command]
pub fn set_taskbar_attention(
    app: AppHandle,
    mode: Option<String>,
    flash_count: Option<u32>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::mem::size_of;
        use windows_sys::Win32::UI::WindowsAndMessaging::{FlashWindowEx, FLASHWINFO};

        let params = taskbar_flash_params(mode.as_deref(), flash_count)?;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "taskbar_main_window_missing".to_string())?;
        let hwnd = window
            .hwnd()
            .map_err(|err| format!("taskbar_window_handle_failed: {err}"))?;
        let info = FLASHWINFO {
            cbSize: size_of::<FLASHWINFO>() as u32,
            hwnd: hwnd.0 as _,
            dwFlags: params.flags,
            uCount: params.count,
            dwTimeout: 0,
        };
        unsafe {
            FlashWindowEx(&info);
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        validate_taskbar_attention_request(mode.as_deref(), flash_count)
    }
}

fn validate_taskbar_attention_request(
    mode: Option<&str>,
    flash_count: Option<u32>,
) -> Result<(), String> {
    match mode {
        None => Ok(()),
        Some("finite") => match flash_count {
            Some(count) if (MIN_TASKBAR_FLASH_COUNT..=MAX_TASKBAR_FLASH_COUNT).contains(&count) => {
                Ok(())
            }
            _ => Err("taskbar_flash_count_out_of_range".into()),
        },
        Some("untilFocused") => Ok(()),
        Some(_) => Err("taskbar_attention_mode_invalid".into()),
    }
}

#[cfg(target_os = "windows")]
fn taskbar_flash_params(
    mode: Option<&str>,
    flash_count: Option<u32>,
) -> Result<TaskbarFlashParams, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FLASHW_STOP, FLASHW_TIMERNOFG, FLASHW_TRAY};

    validate_taskbar_attention_request(mode, flash_count)?;
    Ok(match mode {
        None => TaskbarFlashParams {
            flags: FLASHW_STOP,
            count: 0,
        },
        Some("finite") => TaskbarFlashParams {
            flags: FLASHW_TRAY,
            count: flash_count.expect("validated finite flash count"),
        },
        Some("untilFocused") => TaskbarFlashParams {
            flags: FLASHW_TRAY | FLASHW_TIMERNOFG,
            count: u32::MAX,
        },
        Some(_) => unreachable!("mode validated above"),
    })
}

#[cfg(windows)]
fn spawn_powershell_notification(script: &str) -> Result<(), String> {
    crate::shell_resolver::silent_command("powershell.exe")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to spawn powershell.exe: {}", e))
}

#[cfg(target_os = "windows")]
fn should_use_registered_windows_app_id() -> bool {
    use std::path::MAIN_SEPARATOR as SEP;

    let Ok(exe) = tauri::utils::platform::current_exe() else {
        return false;
    };
    let Some(exe_dir) = exe.parent() else {
        return false;
    };
    let curr_dir = exe_dir.display().to_string();
    !(curr_dir.ends_with(format!("{SEP}target{SEP}debug").as_str())
        || curr_dir.ends_with(format!("{SEP}target{SEP}release").as_str()))
}

#[cfg(not(windows))]
fn spawn_powershell_notification(script: &str) -> Result<(), String> {
    std::process::Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to spawn powershell.exe: {}", e))
}

fn validate_notification_title(title: &str) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("notification_title_empty".into());
    }
    validate_notification_text(title, MAX_NOTIFICATION_TITLE_CHARS, "notification_title")
}

fn validate_notification_body(body: &str) -> Result<(), String> {
    validate_notification_text(body, MAX_NOTIFICATION_BODY_CHARS, "notification_body")
}

fn validate_notification_text(value: &str, max_chars: usize, field: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("{}_contains_nul", field));
    }
    if value.chars().count() > max_chars {
        return Err(format!("{}_too_long", field));
    }
    Ok(())
}

/// XML 特殊字符转义（用于 Toast XML），并替换 XML 1.0 不允许的控制字符。
fn xml_escape(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            '\t' | '\n' | '\r' => escaped.push(ch),
            ch if ch.is_control() => escaped.push(' '),
            ch => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FLASHW_STOP, FLASHW_TIMERNOFG, FLASHW_TRAY};

    #[test]
    fn finite_taskbar_attention_accepts_boundaries() {
        assert_eq!(
            taskbar_flash_params(Some("finite"), Some(1)).unwrap(),
            TaskbarFlashParams {
                flags: FLASHW_TRAY,
                count: 1,
            }
        );
        assert_eq!(
            taskbar_flash_params(Some("finite"), Some(20)).unwrap(),
            TaskbarFlashParams {
                flags: FLASHW_TRAY,
                count: 20,
            }
        );
    }

    #[test]
    fn finite_taskbar_attention_rejects_out_of_range_counts() {
        assert!(taskbar_flash_params(Some("finite"), Some(0)).is_err());
        assert!(taskbar_flash_params(Some("finite"), Some(21)).is_err());
        assert!(taskbar_flash_params(Some("finite"), None).is_err());
    }

    #[test]
    fn until_focused_and_stop_use_expected_flags() {
        assert_eq!(
            taskbar_flash_params(Some("untilFocused"), None).unwrap(),
            TaskbarFlashParams {
                flags: FLASHW_TRAY | FLASHW_TIMERNOFG,
                count: u32::MAX,
            }
        );
        assert_eq!(
            taskbar_flash_params(None, None).unwrap(),
            TaskbarFlashParams {
                flags: FLASHW_STOP,
                count: 0,
            }
        );
    }

    #[test]
    fn custom_sound_flags_play_async_filename_without_default_fallback() {
        use windows_sys::Win32::Media::Audio::{SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

        assert_eq!(
            custom_sound_play_flags(),
            SND_ASYNC | SND_FILENAME | SND_NODEFAULT
        );
    }

    #[test]
    fn custom_sound_path_rejects_empty_input() {
        assert_eq!(
            resolve_notification_sound_path("   ").unwrap_err(),
            "notification_sound_path_empty"
        );
    }

    #[test]
    fn valid_wav_path_accepts_uppercase_extension() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hook-alert.WAV");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"RIFF\x04\x00\x00\x00WAVE").unwrap();

        assert_eq!(
            resolve_notification_sound_path(path.to_str().unwrap()).unwrap(),
            path.canonicalize().unwrap()
        );
    }

    #[test]
    fn custom_sound_path_rejects_non_wav_and_malformed_content() {
        let directory = tempfile::tempdir().unwrap();
        let mp3_path = directory.path().join("hook-alert.mp3");
        File::create(&mp3_path).unwrap();
        assert_eq!(
            resolve_notification_sound_path(mp3_path.to_str().unwrap()).unwrap_err(),
            "notification_sound_format_unsupported"
        );

        let malformed_path = directory.path().join("hook-alert.wav");
        File::create(&malformed_path).unwrap();
        assert_eq!(
            resolve_notification_sound_path(malformed_path.to_str().unwrap()).unwrap_err(),
            "notification_sound_invalid_wave"
        );
    }

    #[test]
    fn custom_sound_path_rejects_missing_file_and_directory() {
        let directory = tempfile::tempdir().unwrap();
        let missing_path = directory.path().join("missing.wav");
        assert_eq!(
            resolve_notification_sound_path(missing_path.to_str().unwrap()).unwrap_err(),
            "notification_sound_unavailable"
        );

        let directory_path = directory.path().join("sounds.wav");
        std::fs::create_dir(&directory_path).unwrap();
        assert_eq!(
            resolve_notification_sound_path(directory_path.to_str().unwrap()).unwrap_err(),
            "notification_sound_not_file"
        );
    }

    #[test]
    fn custom_sound_path_rejects_oversized_file_before_header_read() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversized.wav");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_NOTIFICATION_SOUND_FILE_BYTES + 1).unwrap();

        assert_eq!(
            resolve_notification_sound_path(path.to_str().unwrap()).unwrap_err(),
            "notification_sound_too_large"
        );
    }

    #[test]
    fn custom_sound_path_rejects_nul_and_oversized_input() {
        assert_eq!(
            resolve_notification_sound_path("C:\\sounds\\alert\0.wav").unwrap_err(),
            "notification_sound_path_contains_nul"
        );
        assert_eq!(
            resolve_notification_sound_path(&format!(
                "{}.wav",
                "a".repeat(MAX_NOTIFICATION_SOUND_PATH_CHARS)
            ))
            .unwrap_err(),
            "notification_sound_path_too_long"
        );
    }
}
