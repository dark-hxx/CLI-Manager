// WSL path conversion is shared by the Tauri compatibility layer and native shell.
pub use cli_manager_core::wsl::{
    is_wsl_config_dir, linux_to_unc_wsl_path, normalize_wsl_unc_path, parse_wsl_unc_path,
    windows_path_to_wsl, wsl_mnt_path_to_windows,
};

/// Locate the system WSL executable without starting a probe process.
pub fn find_wsl_exe() -> Option<std::path::PathBuf> {
    std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .map(|root| root.join("System32").join("wsl.exe"))
        .filter(|candidate| candidate.exists())
}
