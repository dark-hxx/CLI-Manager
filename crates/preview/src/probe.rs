use crate::WebViewAvailability;
use std::path::PathBuf;

#[derive(Debug)]
pub struct Probe {
    disabled: bool,
    loader_path: Option<PathBuf>,
    cached: Option<WebViewAvailability>,
}

impl Probe {
    pub fn new(disabled: bool, loader_path: Option<PathBuf>) -> Self {
        Self {
            disabled,
            loader_path,
            cached: None,
        }
    }

    pub fn from_environment() -> Self {
        let disabled = std::env::var("CLI_MANAGER_PREVIEW_DISABLED")
            .ok()
            .is_some_and(|value| {
                matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes")
            });
        let loader_path = std::env::var_os("CLI_MANAGER_WEBVIEW2_LOADER").map(PathBuf::from);
        Self::new(disabled, loader_path)
    }

    pub fn with_availability(availability: WebViewAvailability) -> Self {
        Self {
            disabled: false,
            loader_path: None,
            cached: Some(availability),
        }
    }

    pub fn probe(&mut self) -> WebViewAvailability {
        if let Some(cached) = &self.cached {
            return cached.clone();
        }
        let result = if self.disabled {
            WebViewAvailability::DisabledByUser
        } else {
            platform_probe(self.loader_path.as_deref())
        };
        self.cached = Some(result.clone());
        result
    }

    pub fn clear_cache(&mut self) {
        self.cached = None;
    }

    pub fn set_disabled(&mut self, disabled: bool) {
        if self.disabled != disabled {
            self.disabled = disabled;
            self.clear_cache();
        }
    }

    pub fn is_disabled(&self) -> bool {
        self.disabled
    }

    pub fn cached(&self) -> Option<&WebViewAvailability> {
        self.cached.as_ref()
    }
}

#[cfg(windows)]
fn platform_probe(loader_path: Option<&std::path::Path>) -> WebViewAvailability {
    use std::ffi::{CString, OsStr};
    use std::os::windows::ffi::OsStrExt;

    let Some(path) = loader_path else {
        return WebViewAvailability::Missing;
    };
    if !path.is_absolute() || !path.is_file() {
        return WebViewAvailability::Missing;
    }
    let wide = OsStr::new(path)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    const LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
    unsafe {
        let module = LoadLibraryExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        );
        if module.is_null() {
            return WebViewAvailability::Failed {
                reason: "webview2_loader_load_failed".into(),
            };
        }
        let symbol =
            CString::new("GetAvailableCoreWebView2BrowserVersionString").expect("static symbol");
        let address = GetProcAddress(module, symbol.as_ptr());
        if address.is_null() {
            FreeLibrary(module);
            return WebViewAvailability::Failed {
                reason: "webview2_probe_export_missing".into(),
            };
        }
        let get_version: unsafe extern "system" fn(*const u16, *mut *mut u16) -> i32 =
            std::mem::transmute(address);
        let mut version = std::ptr::null_mut();
        let result = get_version(std::ptr::null(), &mut version);
        if result != 0 || version.is_null() {
            FreeLibrary(module);
            return WebViewAvailability::Failed {
                reason: "webview2_version_probe_failed".into(),
            };
        }
        let mut length = 0;
        while *version.add(length) != 0 {
            length += 1;
        }
        let version_string = String::from_utf16_lossy(std::slice::from_raw_parts(version, length));
        CoTaskMemFree(version.cast());
        FreeLibrary(module);
        if version_string.is_empty() {
            WebViewAvailability::Failed {
                reason: "webview2_version_empty".into(),
            }
        } else {
            WebViewAvailability::Available {
                engine: "webview2".into(),
                version: version_string,
            }
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryExW(
        name: *const u16,
        file: *mut std::ffi::c_void,
        flags: u32,
    ) -> *mut std::ffi::c_void;
    fn GetProcAddress(
        module: *mut std::ffi::c_void,
        name: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_void;
    fn FreeLibrary(module: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoTaskMemFree(memory: *mut std::ffi::c_void);
}

#[cfg(target_os = "macos")]
fn platform_probe(_loader_path: Option<&std::path::Path>) -> WebViewAvailability {
    WebViewAvailability::Available {
        engine: "wkwebview".into(),
        version: "system".into(),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_probe(_loader_path: Option<&std::path::Path>) -> WebViewAvailability {
    WebViewAvailability::Unsupported
}

#[cfg(not(any(windows, unix)))]
fn platform_probe(_loader_path: Option<&std::path::Path>) -> WebViewAvailability {
    WebViewAvailability::Unsupported
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_probe_is_cached_and_can_be_reset() {
        let mut probe = Probe::new(true, None);
        assert_eq!(probe.probe(), WebViewAvailability::DisabledByUser);
        assert!(probe.cached().is_some());
        probe.clear_cache();
        assert!(probe.cached().is_none());
    }

    #[test]
    fn windows_probe_requires_a_controlled_absolute_loader_path() {
        #[cfg(windows)]
        assert_eq!(
            Probe::new(false, None).probe(),
            WebViewAvailability::Missing
        );
    }
}
