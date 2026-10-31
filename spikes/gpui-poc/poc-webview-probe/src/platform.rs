use serde_json::{json, Value};
use std::{
    ffi::{c_void, OsStr},
    os::windows::ffi::OsStrExt,
    path::Path,
};
use windows_sys::Win32::{
    Foundation::{FreeLibrary, HMODULE},
    System::{
        Com::CoTaskMemFree,
        LibraryLoader::{
            GetModuleHandleW, GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        },
    },
};
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY},
    RegKey,
};

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

pub fn loader_loaded() -> bool {
    let name = wide(OsStr::new("WebView2Loader.dll"));
    // This does not load the module or increment its reference count.
    !unsafe { GetModuleHandleW(name.as_ptr()) }.is_null()
}

struct Library(HMODULE);
impl Drop for Library {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                FreeLibrary(self.0);
            }
        }
    }
}

struct ApiString(*mut u16);
impl Drop for ApiString {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CoTaskMemFree(self.0.cast::<c_void>());
            }
        }
    }
}

pub fn probe(path: &Path, minimum_major: u32, hold_ms: u64) -> Value {
    if !path.is_absolute()
        || !path.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .eq_ignore_ascii_case("WebView2Loader.dll")
        })
    {
        return json!({"availability": "Failed", "reason": "absolute_webview2loader_path_required"});
    }
    let absolute = match path.canonicalize() {
        Ok(value) => value,
        Err(error) => {
            return json!({"availability": "Failed", "reason": "loader_path_unavailable",
            "win32Error": error.raw_os_error()})
        }
    };
    let wide_path = wide(absolute.as_os_str());
    let module = Library(unsafe {
        LoadLibraryExW(
            wide_path.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    });
    if module.0.is_null() {
        return json!({"availability": "Failed", "reason": "loader_load_failed",
            "win32Error": std::io::Error::last_os_error().raw_os_error()});
    }
    let during = loader_loaded();
    super::emit(
        json!({"event": "loader_loaded", "pid": std::process::id(), "loaderLoaded": during}),
    );
    super::hold(hold_ms);
    let result = call_api(&module, minimum_major);
    drop(module);
    json!({"loaderPath": absolute, "duringLoaderLoaded": during,
        "afterUnloadLoaderLoaded": loader_loaded(), "runtime": result})
}

fn call_api(module: &Library, minimum_major: u32) -> Value {
    let Some(address) = (unsafe {
        GetProcAddress(
            module.0,
            c"GetAvailableCoreWebView2BrowserVersionString"
                .as_ptr()
                .cast(),
        )
    }) else {
        return json!({"availability": "Failed", "reason": "version_export_missing"});
    };
    // WebView2.h: HRESULT STDAPICALLTYPE fn(PCWSTR folder, LPWSTR *versionInfo).
    // Resolved dynamically: there is no webview2-com/wry or static Loader import.
    type GetVersion = unsafe extern "system" fn(*const u16, *mut *mut u16) -> i32;
    let get_version: GetVersion = unsafe { std::mem::transmute(address) };
    let mut value = ApiString(std::ptr::null_mut());
    let hresult = unsafe { get_version(std::ptr::null(), &mut value.0) };
    let version = if hresult >= 0 && !value.0.is_null() {
        // The API guarantees a NUL-terminated, CoTaskMem-allocated string.
        let mut length = 0;
        while unsafe { *value.0.add(length) } != 0 {
            length += 1;
        }
        match String::from_utf16(unsafe { std::slice::from_raw_parts(value.0, length) }) {
            Ok(text) => Some(text),
            Err(_) => return json!({"availability": "Failed", "reason": "invalid_version_utf16"}),
        }
    } else {
        None
    };
    super::classify::classify(hresult, version.as_deref(), minimum_major)
}

pub fn registry_evidence() -> Vec<Value> {
    // Official distribution guidance: HKCU and HKLM 32-bit view. The native
    // machine view is extra evidence; it cannot override a failed version API.
    let path = r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    [
        ("HKCU", HKEY_CURRENT_USER, 0),
        ("HKLM32", HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
        ("HKLM64", HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
    ]
    .into_iter()
    .map(|(hive, root, view)| {
        let value = RegKey::predef(root)
            .open_subkey_with_flags(path, KEY_READ | view)
            .and_then(|key| key.get_value::<String, _>("pv"));
        match value {
            Ok(pv) => json!({"location": hive, "subkey": path, "valueName": "pv", "pv": pv}),
            Err(error) => json!({"location": hive, "subkey": path, "valueName": "pv",
                "pv": null, "win32Error": error.raw_os_error()}),
        }
    })
    .collect()
}
