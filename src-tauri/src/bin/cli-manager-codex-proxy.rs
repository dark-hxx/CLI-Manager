//! Native Codex app-server shim used by cc-connect on Windows.

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

// 先识别 SSH ProxyCommand，再处理继承的 AskPass 环境，最后进入 Codex shim；各路径自行负责进程退出。
fn main() {
    let args: Vec<String> = std::env::args().collect();
    // ProxyCommand inherits AskPass variables, so route it before AskPass dispatch.
    if cli_manager_lib::ssh_proxy::is_helper_request(&args) {
        cli_manager_lib::ssh_proxy::run_helper_and_exit(&args);
    }
    if std::env::var_os("CLI_MANAGER_SSH_ASKPASS").is_some() {
        cli_manager_lib::ssh_askpass::run_helper_and_exit();
    }
    cli_manager_lib::codex_app_server_proxy::run_shim_and_exit(&args);
}
