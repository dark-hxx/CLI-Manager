#[cfg(target_os = "windows")]
use std::time::Duration;

#[cfg(target_os = "windows")]
fn encode_hdrop(paths: &[std::path::PathBuf]) -> Result<Vec<u8>, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Shell::DROPFILES;

    if paths.is_empty() || paths.len() > 4096 {
        return Err("clipboard_invalid_file_count".into());
    }
    let mut names = Vec::<u16>::new();
    for path in paths {
        let name: Vec<u16> = path.as_os_str().encode_wide().collect();
        if name.contains(&0) { return Err("clipboard_invalid_path".into()); }
        names.extend(name);
        names.push(0);
    }
    names.push(0);
    let header_size = std::mem::size_of::<DROPFILES>();
    let byte_count = header_size.checked_add(names.len().checked_mul(2).ok_or("clipboard_too_large")?)
        .ok_or("clipboard_too_large")?;
    if byte_count > 16 * 1024 * 1024 { return Err("clipboard_too_large".into()); }

    let mut bytes = vec![0u8; byte_count];
    let header = DROPFILES { pFiles: header_size as u32, pt: POINT { x: 0, y: 0 }, fNC: 0, fWide: 1 };
    unsafe {
        std::ptr::write_unaligned(bytes.as_mut_ptr().cast::<DROPFILES>(), header);
        std::ptr::copy_nonoverlapping(names.as_ptr().cast::<u8>(), bytes.as_mut_ptr().add(header_size), names.len() * 2);
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
pub(super) fn write_clipboard_file_paths(paths: &[std::path::PathBuf], owner: usize) -> Result<(), String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    // The clipboard owns each movable global allocation after SetClipboardData succeeds.
    unsafe fn allocate(bytes: &[u8]) -> Result<windows_sys::Win32::Foundation::HGLOBAL, String> {
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
        if handle.is_null() { return Err("clipboard_write_failed".into()); }
        let pointer = unsafe { GlobalLock(handle) };
        if pointer.is_null() {
            unsafe { GlobalFree(handle); }
            return Err("clipboard_write_failed".into());
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len());
            GlobalUnlock(handle);
        }
        Ok(handle)
    }

    let bytes = encode_hdrop(paths)?;
    let hdrop = unsafe { allocate(&bytes)? };
    let effect = 1u32.to_le_bytes();
    let effect_handle = match unsafe { allocate(&effect) } {
        Ok(handle) => handle,
        Err(error) => {
            unsafe { GlobalFree(hdrop); }
            return Err(error);
        }
    };
    let format_name: Vec<u16> = "Preferred DropEffect\0".encode_utf16().collect();
    let effect_format = unsafe { RegisterClipboardFormatW(format_name.as_ptr()) };
    if effect_format == 0 {
        unsafe { GlobalFree(hdrop); GlobalFree(effect_handle); }
        return Err("clipboard_write_failed".into());
    }

    let mut opened = false;
    for _ in 0..5 {
        if unsafe { OpenClipboard(owner as _) } != 0 { opened = true; break; }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !opened {
        unsafe { GlobalFree(hdrop); GlobalFree(effect_handle); }
        return Err("clipboard_busy".into());
    }
    let result = unsafe {
        let mut ok = EmptyClipboard() != 0;
        let mut hdrop_owned = false;
        let mut effect_owned = false;
        if ok {
            hdrop_owned = !SetClipboardData(15, hdrop).is_null();
            ok = hdrop_owned;
        }
        if ok {
            effect_owned = !SetClipboardData(effect_format, effect_handle).is_null();
            ok = effect_owned;
        }
        if !ok { EmptyClipboard(); }
        CloseClipboard();
        if !hdrop_owned { GlobalFree(hdrop); }
        if !effect_owned { GlobalFree(effect_handle); }
        ok
    };
    if result { Ok(()) } else { Err("clipboard_write_failed".into()) }
}

#[cfg(target_os = "windows")]
pub(super) fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_HDROP: u32 = 15;

    // Do not confuse a temporarily locked clipboard with an empty one.
    let mut opened = false;
    for _ in 0..5 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !opened {
        return Err("clipboard_busy".into());
    }

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    let _guard = ClipboardGuard;

    let handle = unsafe { GetClipboardData(CF_HDROP) };
    if handle.is_null() {
        return Ok(Vec::new());
    }

    // DragQueryFileW expects the HDROP handle, not a GlobalLock data pointer.
    let hdrop = handle as HDROP;

    let count = unsafe { DragQueryFileW(hdrop, u32::MAX, std::ptr::null_mut(), 0) };
    if count > 4096 {
        return Err("clipboard_too_many_files".into());
    }
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        // 先查长度（不含结尾 NUL），再按长度 + 1 取内容。
        let len = unsafe { DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0) };
        if len == 0 {
            continue;
        }
        let mut buffer = vec![0u16; len as usize + 1];
        let copied =
            unsafe { DragQueryFileW(hdrop, index, buffer.as_mut_ptr(), buffer.len() as u32) };
        if copied == 0 {
            continue;
        }
        let path = std::ffi::OsString::from_wide(&buffer[..copied as usize]);
        paths.push(path.to_string_lossy().into_owned());
    }

    Ok(paths)
}

#[cfg(target_os = "macos")]
// Finder 的文件 URL 与 Windows CF_HDROP 共用上层文件/图片处理链路。
pub(super) fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    super::clipboard_image::platform::read_file_paths()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(super) fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::encode_hdrop;
    use std::path::PathBuf;
    use windows_sys::Win32::UI::Shell::DROPFILES;

    #[test]
    fn hdrop_encodes_unicode_paths_with_double_nul_terminator() {
        let bytes = encode_hdrop(&[PathBuf::from(r"C:\项目\a.txt"), PathBuf::from(r"C:\项目\b")]).unwrap();
        let header = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast::<DROPFILES>()) };
        let offset = header.pFiles as usize;
        let wide: Vec<u16> = bytes[offset..].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let expected: Vec<u16> = "C:\\项目\\a.txt\0C:\\项目\\b\0\0".encode_utf16().collect();
        assert_eq!(wide, expected);
        let is_wide = header.fWide;
        assert_eq!(is_wide, 1);
    }

    #[test]
    fn hdrop_rejects_empty_selection() {
        assert_eq!(encode_hdrop(&[]).unwrap_err(), "clipboard_invalid_file_count");
    }
}
