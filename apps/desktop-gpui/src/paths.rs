use cli_manager_core::data_paths::{self, Distribution};
use std::path::PathBuf;

/// 与 Tauri 共享数据根规则；后台调用，不执行启动时的数据切换。
pub fn database_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = executable
        .parent()
        .ok_or("current_exe_parent_unavailable")?;
    let distribution = data_paths::distribution(
        std::env::var("CLI_MANAGER_DISTRIBUTION").ok().as_deref(),
        executable.join("portable.flag").is_file(),
        cfg!(windows),
    );
    let home = if distribution == Distribution::Portable {
        PathBuf::new()
    } else {
        std::env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
            .ok_or("home_dir_unavailable")?
    };
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let bootstrap =
        data_paths::bootstrap_path(distribution, local.as_deref(), executable, cfg!(windows))?;
    let default = data_paths::default_root(distribution, &home, executable);
    Ok(data_paths::active_root(&default, bootstrap.as_deref())?.join("cli-manager.db"))
}
