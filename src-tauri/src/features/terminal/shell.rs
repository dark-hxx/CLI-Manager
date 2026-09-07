use serde::Serialize;
use std::env;
use std::path::PathBuf;

#[cfg(target_os = "windows")]
use base64::Engine as _;
#[cfg(target_os = "windows")]
use image::{ImageFormat, RgbaImage};
#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::io::Cursor;
#[cfg(target_os = "windows")]
use std::iter::once;
#[cfg(target_os = "windows")]
use std::mem::{size_of, zeroed};
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

#[derive(Serialize)]
pub struct TerminalShellProfile {
    id: String,
    label: String,
    platform: String,
    kind: String,
    command: String,
    enabled: bool,
    detected: bool,
}

fn profile(platform: &str, command: &str, label: &str) -> TerminalShellProfile {
    TerminalShellProfile {
        id: format!("known:{command}"),
        label: label.to_string(),
        platform: platform.to_string(),
        kind: "known".to_string(),
        command: command.to_string(),
        enabled: true,
        detected: true,
    }
}

fn path_candidate(name: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(name);
    if direct.exists() {
        return Some(direct);
    }
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.exists())
    })
}

fn command_exists(name: &str) -> bool {
    path_candidate(name).is_some()
}

#[cfg(target_os = "windows")]
fn wsl_available() -> bool {
    let Some(wsl) = crate::wsl::find_wsl_exe() else {
        return false;
    };
    let wsl_exe = wsl.to_string_lossy().to_string();
    let mut command = crate::shell_resolver::silent_command(&wsl_exe);
    command.args(["-l", "-q"]);
    // WSL 服务损坏时 wsl.exe 会挂起约 60s，必须限时，否则拖死整个扫描。
    crate::shell_resolver::output_with_timeout(command, std::time::Duration::from_secs(5))
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn scan_windows() -> Vec<TerminalShellProfile> {
    let mut profiles = Vec::new();
    if command_exists("powershell.exe") {
        profiles.push(profile("windows", "powershell", "PowerShell"));
    }
    if command_exists("cmd.exe") {
        profiles.push(profile("windows", "cmd", "CMD"));
    }
    if command_exists("pwsh.exe") {
        profiles.push(profile("windows", "pwsh", "PowerShell 7"));
    }
    if crate::shell_resolver::resolve_git_bash_exe().is_some() {
        profiles.push(profile("windows", "gitbash", "Git Bash"));
    }
    if wsl_available() {
        profiles.push(profile("windows", "wsl", "WSL"));
    }
    profiles
}

#[cfg(target_os = "macos")]
fn scan_macos() -> Vec<TerminalShellProfile> {
    let mut profiles = Vec::new();
    if command_exists("zsh") {
        profiles.push(profile("macos", "zsh", "Zsh"));
    }
    if command_exists("bash") {
        profiles.push(profile("macos", "bash", "Bash"));
    }
    if command_exists("fish") {
        profiles.push(profile("macos", "fish", "Fish"));
    }
    if command_exists("sh") {
        profiles.push(profile("macos", "sh", "Sh"));
    }
    if command_exists("pwsh") {
        profiles.push(profile("macos", "pwsh", "PowerShell 7"));
    }
    profiles
}

#[cfg(target_os = "linux")]
fn scan_linux() -> Vec<TerminalShellProfile> {
    let mut profiles = Vec::new();
    if command_exists("bash") {
        profiles.push(profile("linux", "bash", "Bash"));
    }
    if command_exists("zsh") {
        profiles.push(profile("linux", "zsh", "Zsh"));
    }
    if command_exists("fish") {
        profiles.push(profile("linux", "fish", "Fish"));
    }
    if command_exists("sh") {
        profiles.push(profile("linux", "sh", "Sh"));
    }
    if command_exists("pwsh") {
        profiles.push(profile("linux", "pwsh", "PowerShell 7"));
    }
    profiles
}

// 同步 Tauri 命令会在主线程执行；shell 扫描包含子进程探测（wsl.exe），
// 必须 async + spawn_blocking，否则探测卡住时整个窗口无响应。
#[tauri::command]
pub async fn terminal_shell_scan() -> Result<Vec<TerminalShellProfile>, String> {
    tauri::async_runtime::spawn_blocking(scan_profiles)
        .await
        .map_err(|err| format!("终端 Shell 扫描任务失败: {err}"))
}

/// 获取 Shell 对应可执行文件的 Windows 原生图标，返回可直接用于 `<img>` 的 data URL。
///
/// Shell profile 的 command 可能是逻辑值（如 `powershell`、`gitbash`），也可能是
/// 用户配置的带参数路径，因此解析和图标提取都放在后端完成，避免前端猜测 PATH。
#[tauri::command]
pub async fn terminal_shell_icon(command: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            return windows_shell_icon(&command);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = command;
            Ok(None)
        }
    })
    .await
    .map_err(|err| format!("终端 Shell 图标提取任务失败: {err}"))?
}

#[cfg(target_os = "windows")]
fn command_token(command: &str) -> Option<String> {
    let trimmed = command
        .trim()
        .strip_prefix('&')
        .map(str::trim_start)
        .unwrap_or(command.trim());
    if trimmed.is_empty() {
        return None;
    }
    let first = trimmed.as_bytes().first().copied();
    if matches!(first, Some(b'"' | b'\'')) {
        let quote = first.unwrap() as char;
        let rest = &trimmed[1..];
        let end = rest.find(quote).unwrap_or(rest.len());
        return Some(rest[..end].to_string());
    }
    trimmed.split_whitespace().next().map(str::to_string)
}

#[cfg(target_os = "windows")]
fn system_executable(name: &str) -> Option<PathBuf> {
    env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join(name))
        .filter(|candidate| candidate.exists())
}

#[cfg(target_os = "windows")]
fn resolve_shell_executable(command: &str) -> Option<PathBuf> {
    let token = command_token(command)?;
    let key = token.to_ascii_lowercase();
    match key.as_str() {
        "powershell" | "powershell.exe" => {
            system_executable("WindowsPowerShell\\v1.0\\powershell.exe")
                .or_else(|| path_candidate("powershell.exe"))
        }
        "cmd" | "cmd.exe" => system_executable("cmd.exe").or_else(|| path_candidate("cmd.exe")),
        "pwsh" | "pwsh.exe" => path_candidate("pwsh.exe").or_else(|| path_candidate("pwsh")),
        "wsl" | "wsl.exe" => crate::wsl::find_wsl_exe(),
        "gitbash" | "git-bash" | "git-bash.exe" => crate::shell_resolver::resolve_git_bash_exe(),
        _ => path_candidate(&token).or_else(|| {
            (!key.ends_with(".exe")).then(|| path_candidate(&format!("{token}.exe")))?
        }),
    }
}

#[cfg(target_os = "windows")]
fn windows_shell_icon(command: &str) -> Result<Option<String>, String> {
    let Some(path) = resolve_shell_executable(command) else {
        return Ok(None);
    };
    let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    let mut file_info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            wide_path.as_ptr(),
            0,
            &mut file_info,
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if result == 0 || file_info.hIcon.is_null() {
        return Ok(None);
    }

    let icon = file_info.hIcon;
    let png = unsafe { icon_to_png(icon) };
    unsafe {
        DestroyIcon(icon);
    }
    let png = png?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    Ok(Some(format!("data:image/png;base64,{encoded}")))
}

#[cfg(target_os = "windows")]
unsafe fn icon_to_png(icon: HICON) -> Result<Vec<u8>, String> {
    let mut icon_info: ICONINFO = zeroed();
    if GetIconInfo(icon, &mut icon_info) == 0 {
        return Err("GetIconInfo failed".to_string());
    }

    let pixels = bitmap_to_rgba(icon_info.hbmColor, icon_info.hbmMask);
    if !icon_info.hbmColor.is_null() {
        DeleteObject(icon_info.hbmColor as _);
    }
    if !icon_info.hbmMask.is_null() {
        DeleteObject(icon_info.hbmMask as _);
    }
    let (width, height, rgba) = pixels?;
    let image = RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "Windows Shell icon bitmap size is invalid".to_string())?;
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|err| format!("encode Windows Shell icon failed: {err}"))?;
    Ok(png)
}

#[cfg(target_os = "windows")]
unsafe fn bitmap_to_rgba(
    color_bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    mask_bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
) -> Result<(u32, u32, Vec<u8>), String> {
    if color_bitmap.is_null() {
        return Err("Windows Shell icon has no color bitmap".to_string());
    }
    let mut bitmap: BITMAP = zeroed();
    if GetObjectW(
        color_bitmap as _,
        size_of::<BITMAP>() as i32,
        &mut bitmap as *mut _ as *mut c_void,
    ) == 0
    {
        return Err("GetObjectW failed for Windows Shell icon".to_string());
    }

    let width = bitmap.bmWidth.unsigned_abs();
    let height = bitmap.bmHeight.unsigned_abs();
    if width == 0 || height == 0 || width > 256 || height > 256 {
        return Err("Windows Shell icon bitmap dimensions are invalid".to_string());
    }

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bgra = vec![0u8; width as usize * height as usize * 4];
    let hdc = GetDC(std::ptr::null_mut());
    if hdc.is_null() {
        return Err("GetDC failed while reading Windows Shell icon".to_string());
    }
    let copied = GetDIBits(
        hdc,
        color_bitmap,
        0,
        height,
        bgra.as_mut_ptr() as *mut c_void,
        &mut info,
        DIB_RGB_COLORS,
    );
    ReleaseDC(std::ptr::null_mut(), hdc);
    if copied == 0 {
        return Err("GetDIBits failed for Windows Shell icon".to_string());
    }

    let alpha_is_empty = bgra.chunks_exact(4).all(|pixel| pixel[3] == 0);
    let mask_alpha = alpha_is_empty.then(|| read_mask_alpha(mask_bitmap, width, height));
    let mut rgba = Vec::with_capacity(bgra.len());
    for (index, pixel) in bgra.chunks_exact(4).enumerate() {
        let alpha = mask_alpha
            .as_ref()
            .and_then(Option::as_ref)
            .map(|mask| mask[index])
            .unwrap_or(if alpha_is_empty { 255 } else { pixel[3] });
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], alpha]);
    }
    Ok((width, height, rgba))
}

#[cfg(target_os = "windows")]
unsafe fn read_mask_alpha(
    mask_bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    if mask_bitmap.is_null() {
        return None;
    }
    let row_bytes = width.div_ceil(32) * 4;
    let mut mask_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 1,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut mask = vec![0u8; row_bytes as usize * height as usize];
    let hdc = GetDC(std::ptr::null_mut());
    if hdc.is_null() {
        return None;
    }
    let copied = GetDIBits(
        hdc,
        mask_bitmap,
        0,
        height,
        mask.as_mut_ptr() as *mut c_void,
        &mut mask_info,
        DIB_RGB_COLORS,
    );
    ReleaseDC(std::ptr::null_mut(), hdc);
    if copied == 0 {
        return None;
    }

    let mut alpha = vec![255u8; width as usize * height as usize];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let bit = mask[y * row_bytes as usize + x / 8] & (0x80 >> (x % 8));
            alpha[y * width as usize + x] = if bit == 0 { 255 } else { 0 };
        }
    }
    Some(alpha)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{command_token, windows_shell_icon};

    #[test]
    fn command_token_supports_quoted_executable_paths() {
        assert_eq!(
            command_token(r#"& "C:\Program Files\nu\nu.exe" --login"#),
            Some(r#"C:\Program Files\nu\nu.exe"#.to_string())
        );
    }

    #[test]
    fn extracts_native_cmd_icon() {
        let icon = windows_shell_icon("cmd").expect("cmd icon extraction should not fail");
        assert!(icon.is_some_and(|value| value.starts_with("data:image/png;base64,")));
    }
}

fn scan_profiles() -> Vec<TerminalShellProfile> {
    #[cfg(target_os = "windows")]
    {
        return scan_windows();
    }
    #[cfg(target_os = "macos")]
    {
        return scan_macos();
    }
    #[cfg(target_os = "linux")]
    {
        return scan_linux();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Vec::new()
    }
}
