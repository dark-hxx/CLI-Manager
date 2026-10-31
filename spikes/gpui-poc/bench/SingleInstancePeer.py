"""Independent receiver for the isolated Tauri 2.4.2 Windows wire-format experiment."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import re
import time


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--namespace', required=True)
    parser.add_argument('--ready', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'com\.cli-manager\.gpui-poc\.[a-zA-Z0-9-]{1,80}', args.namespace):
        raise ValueError('only an isolated PoC namespace is permitted')
    if args.ready.exists() or args.output.exists():
        raise FileExistsError('peer evidence paths must be new')
    user = c.WinDLL('user32', use_last_error=True)
    kernel = c.WinDLL('kernel32', use_last_error=True)
    callback_type = c.WINFUNCTYPE(c.c_ssize_t, w.HWND, w.UINT, c.c_size_t, c.c_ssize_t)

    class WindowClass(c.Structure):
        _fields_ = [('style', w.UINT), ('proc', callback_type), ('class_extra', c.c_int),
                    ('window_extra', c.c_int), ('instance', w.HINSTANCE), ('icon', w.HICON),
                    ('cursor', w.HANDLE), ('background', w.HBRUSH), ('menu', w.LPCWSTR),
                    ('name', w.LPCWSTR)]

    class CopyData(c.Structure):
        _fields_ = [('kind', c.c_size_t), ('size', w.DWORD), ('data', c.c_void_p)]

    kernel.CreateMutexW.argtypes = [c.c_void_p, w.BOOL, w.LPCWSTR]
    kernel.CreateMutexW.restype = w.HANDLE
    kernel.ReleaseMutex.argtypes = [w.HANDLE]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.GetModuleHandleW.argtypes = [w.LPCWSTR]
    kernel.GetModuleHandleW.restype = w.HINSTANCE
    user.RegisterClassW.argtypes = [c.POINTER(WindowClass)]
    user.RegisterClassW.restype = w.WORD
    user.UnregisterClassW.argtypes = [w.LPCWSTR, w.HINSTANCE]
    user.CreateWindowExW.argtypes = [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD,
                                   c.c_int, c.c_int, c.c_int, c.c_int,
                                   w.HWND, w.HMENU, w.HINSTANCE, c.c_void_p]
    user.CreateWindowExW.restype = w.HWND
    user.DestroyWindow.argtypes = [w.HWND]
    user.DefWindowProcW.argtypes = [w.HWND, w.UINT, c.c_size_t, c.c_ssize_t]
    user.DefWindowProcW.restype = c.c_ssize_t
    user.PeekMessageW.argtypes = [c.POINTER(w.MSG), w.HWND, w.UINT, w.UINT, w.UINT]
    user.TranslateMessage.argtypes = [c.POINTER(w.MSG)]
    user.DispatchMessageW.argtypes = [c.POINTER(w.MSG)]
    user.DispatchMessageW.restype = c.c_ssize_t
    received = []
    errors = []

    @callback_type
    def window_proc(hwnd, msg, wp, lp):
        if msg == 0x4a and lp:
            try:
                packet = c.cast(lp, c.POINTER(CopyData)).contents
                if packet.kind != 1542 or not packet.data or not 0 < packet.size <= 65536:
                    return 0
                payload = c.string_at(packet.data, packet.size)
                if not payload.endswith(b'\0') or b'\0' in payload[:-1]:
                    return 0
                cwd, *argv = payload[:-1].decode('utf-8').split('|')
                if not argv:
                    return 0
                received.append({'cwd': cwd, 'argv': argv})
                return 1
            except Exception as error:
                errors.append(str(error))
                return 0
        return user.DefWindowProcW(hwnd, msg, wp, lp)

    mutex = kernel.CreateMutexW(None, True, args.namespace + '-sim')
    if not mutex:
        raise c.WinError(c.get_last_error())
    if c.get_last_error() == 183:
        kernel.CloseHandle(mutex)
        raise RuntimeError('isolated namespace already in use')
    instance = kernel.GetModuleHandleW(None)
    class_name = args.namespace + '-sic'
    wc = WindowClass(proc=window_proc, instance=instance, name=class_name)
    hwnd = None
    registered = False
    try:
        if not user.RegisterClassW(c.byref(wc)):
            raise c.WinError(c.get_last_error())
        registered = True
        hwnd = user.CreateWindowExW(0x80, class_name, args.namespace + '-siw', 0x80000000,
                                    0, 0, 0, 0, None, None, instance, None)
        if not hwnd:
            raise c.WinError(c.get_last_error())
        args.ready.write_text(json.dumps({'pid': os.getpid(), 'hwnd': hwnd}), encoding='utf-8')
        message = w.MSG()
        deadline = time.monotonic() + 15
        while not received and not errors and time.monotonic() < deadline:
            while user.PeekMessageW(c.byref(message), None, 0, 0, 1):
                user.TranslateMessage(c.byref(message))
                user.DispatchMessageW(c.byref(message))
            time.sleep(0.005)
        if not received or errors:
            raise RuntimeError(f'peer receive failed: {errors or "timeout"}')
    finally:
        destroyed = bool(user.DestroyWindow(hwnd)) if hwnd else False
        unregistered = bool(user.UnregisterClassW(class_name, instance)) if registered else False
        released = bool(kernel.ReleaseMutex(mutex))
        closed = bool(kernel.CloseHandle(mutex))
        args.output.write_text(json.dumps({'received': received, 'errors': errors,
            'destroyed': destroyed, 'unregistered': unregistered,
            'released': released, 'closed': closed}, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    run()
