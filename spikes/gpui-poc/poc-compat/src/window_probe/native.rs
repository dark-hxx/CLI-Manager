//! Isolated Win32 resources. All HWND operations run on their owning UI thread.
use super::protocol;
use std::{
    io,
    ptr::{null, null_mut},
    sync::mpsc::Sender,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM, LRESULT, POINT,
        WPARAM,
    },
    System::{
        DataExchange::COPYDATASTRUCT,
        LibraryLoader::GetModuleHandleW,
        Threading::{CreateMutexW, ReleaseMutex},
    },
    UI::{
        Shell::{
            Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
        },
        WindowsAndMessaging::*,
    },
};

const TRAY_MESSAGE: u32 = WM_APP + 1;
pub const SHOW: usize = 101;
pub const HIDE: usize = 102;
pub const QUIT: usize = 103;

pub enum Event {
    Show,
    Hide,
    Quit,
    Forwarded { cwd: String, args: Vec<String> },
}
struct State {
    tx: Sender<Event>,
    chinese: bool,
}
pub struct NativeHost {
    hwnd: HWND,
    mutex: HANDLE,
    class: Vec<u16>,
    state: Box<State>,
    tray: bool,
}

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn os_error() -> String {
    io::Error::last_os_error().to_string()
}

impl NativeHost {
    /// None means this process forwarded to the existing isolated instance.
    pub fn acquire(id: &str, chinese: bool, tx: Sender<Event>) -> Result<Option<Self>, String> {
        let suffix = id
            .strip_prefix("com.cli-manager.gpui-poc.")
            .ok_or("non-PoC namespace forbidden")?;
        if suffix.is_empty()
            || suffix.len() > 80
            || !suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("namespace suffix must be 1..80 ASCII letters/digits/hyphens".into());
        }
        let args = std::env::args().collect::<Vec<_>>();
        let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
        let payload = protocol::encode(cwd.to_str().ok_or("cwd is not Unicode")?, &args)?;
        let class = wide(&format!("{id}-sic"));
        let title = wide(&format!("{id}-siw"));
        unsafe {
            let mutex = CreateMutexW(null(), 1, wide(&format!("{id}-sim")).as_ptr());
            if mutex.is_null() {
                return Err(os_error());
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let deadline = Instant::now() + Duration::from_secs(3);
                let target = loop {
                    let target = FindWindowW(class.as_ptr(), title.as_ptr());
                    if !target.is_null() {
                        break target;
                    }
                    if Instant::now() >= deadline {
                        CloseHandle(mutex);
                        return Err("mutex exists but receiver did not become ready".into());
                    }
                    std::thread::sleep(Duration::from_millis(20));
                };
                let data = COPYDATASTRUCT {
                    dwData: 1542,
                    cbData: payload.len() as u32,
                    lpData: payload.as_ptr() as _,
                };
                let mut reply = 0;
                let sent = SendMessageTimeoutW(
                    target,
                    WM_COPYDATA,
                    0,
                    &data as *const _ as _,
                    SMTO_ABORTIFHUNG | SMTO_BLOCK,
                    2000,
                    &mut reply,
                );
                CloseHandle(mutex);
                if sent == 0 || reply != 1 {
                    return Err("single-instance receiver rejected or timed out".into());
                }
                println!("single-instance: forwarded argc={}", args.len());
                return Ok(None);
            }
            let mut host = Self {
                hwnd: null_mut(),
                mutex,
                class,
                state: Box::new(State { tx, chinese }),
                tray: false,
            };
            let instance = GetModuleHandleW(null());
            let wc = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance,
                lpszClassName: host.class.as_ptr(),
                ..std::mem::zeroed()
            };
            if RegisterClassW(&wc) == 0 {
                return Err(os_error());
            }
            host.hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                host.class.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                instance,
                &mut *host.state as *mut State as _,
            );
            if host.hwnd.is_null() {
                return Err(os_error());
            }
            println!("single-instance: primary receiver={}", host.hwnd as usize);
            Ok(Some(host))
        }
    }

    pub fn add_tray(&mut self) -> Result<(), String> {
        unsafe {
            let mut icon: NOTIFYICONDATAW = std::mem::zeroed();
            icon.cbSize = std::mem::size_of_val(&icon) as u32;
            icon.hWnd = self.hwnd;
            icon.uID = 1;
            icon.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
            icon.uCallbackMessage = TRAY_MESSAGE;
            icon.hIcon = LoadIconW(null_mut(), IDI_APPLICATION); // Shared system icon, not a bundled asset.
            let tip = wide(if self.state.chinese {
                "GPUI 窗口隔离实验"
            } else {
                "GPUI isolated window probe"
            });
            icon.szTip[..tip.len()].copy_from_slice(&tip);
            if icon.hIcon.is_null() || Shell_NotifyIconW(NIM_ADD, &icon) == 0 {
                return Err(os_error());
            }
            self.tray = true;
            println!("tray: added");
            Ok(())
        }
    }
}

impl Drop for NativeHost {
    fn drop(&mut self) {
        unsafe {
            if self.tray {
                let mut icon: NOTIFYICONDATAW = std::mem::zeroed();
                icon.cbSize = std::mem::size_of_val(&icon) as u32;
                icon.hWnd = self.hwnd;
                icon.uID = 1;
                println!(
                    "tray: deleted={}",
                    Shell_NotifyIconW(NIM_DELETE, &icon) != 0
                );
            }
            if !self.hwnd.is_null() {
                DestroyWindow(self.hwnd);
            }
            UnregisterClassW(self.class.as_ptr(), GetModuleHandleW(null()));
            ReleaseMutex(self.mutex);
            CloseHandle(self.mutex);
            println!("single-instance: resources released");
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_NCCREATE {
        let create = &*(lp as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as _);
    }
    let state = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const State).as_ref();
    if let Some(state) = state {
        if msg == WM_COPYDATA && lp != 0 {
            let cds = &*(lp as *const COPYDATASTRUCT);
            if cds.dwData != 1542
                || cds.cbData == 0
                || cds.cbData as usize > protocol::MAX_BYTES
                || cds.lpData.is_null()
            {
                return 0;
            }
            let bytes = std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize);
            return match protocol::decode(bytes) {
                Ok((cwd, args)) => state.tx.send(Event::Forwarded { cwd, args }).is_ok() as _,
                Err(_) => 0,
            };
        }
        let command = if msg == TRAY_MESSAGE && lp as u32 == WM_RBUTTONUP {
            tray_menu(hwnd, state.chinese)
        } else if msg == TRAY_MESSAGE && lp as u32 == WM_LBUTTONUP {
            SHOW
        } else if msg == WM_COMMAND {
            wp & 0xffff
        } else {
            0
        };
        let event = match command {
            SHOW => Some(Event::Show),
            HIDE => Some(Event::Hide),
            QUIT => Some(Event::Quit),
            _ => None,
        };
        if let Some(event) = event {
            let _ = state.tx.send(event);
            return 0;
        }
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

unsafe fn tray_menu(hwnd: HWND, chinese: bool) -> usize {
    let menu = CreatePopupMenu();
    if menu.is_null() {
        return 0;
    }
    let labels = if chinese {
        ["显示主窗口", "隐藏主窗口", "退出实验"]
    } else {
        ["Show main window", "Hide main window", "Exit probe"]
    };
    for (id, label) in [SHOW, HIDE, QUIT].into_iter().zip(labels) {
        AppendMenuW(menu, MF_STRING, id, wide(label).as_ptr());
    }
    let mut point = POINT { x: 0, y: 0 };
    GetCursorPos(&mut point);
    SetForegroundWindow(hwnd);
    let command = TrackPopupMenu(
        menu,
        TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
        point.x,
        point.y,
        0,
        hwnd,
        null(),
    ) as usize;
    PostMessageW(hwnd, WM_NULL, 0, 0);
    DestroyMenu(menu);
    command
}

pub fn show(hwnd: usize) {
    unsafe {
        ShowWindow(hwnd as _, SW_RESTORE);
        SetForegroundWindow(hwnd as _);
    }
}
pub fn hide(hwnd: usize) {
    unsafe {
        ShowWindow(hwnd as _, SW_HIDE);
    }
}
pub fn alive(hwnd: usize) -> bool {
    unsafe { IsWindow(hwnd as _) != 0 }
}

pub fn configure_pet(hwnd: usize) -> Result<(), String> {
    unsafe {
        let hwnd = hwnd as HWND;
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        SetWindowLongPtrW(
            hwnd,
            GWL_STYLE,
            ((style & !(WS_CAPTION | WS_THICKFRAME)) | WS_POPUP) as _,
        );
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            ((ex & !WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW) as _,
        );
        if SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        ) == 0
        {
            return Err(os_error());
        }
        println!(
            "pet: hwnd={} ex_style={:x} style={:x}",
            hwnd as usize,
            GetWindowLongPtrW(hwnd, GWL_EXSTYLE),
            GetWindowLongPtrW(hwnd, GWL_STYLE)
        );
        Ok(())
    }
}
