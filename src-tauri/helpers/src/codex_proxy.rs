#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if cli_manager::ssh_proxy::is_helper_request(&args) {
        cli_manager::ssh_proxy::run_helper_and_exit(&args);
    }
    if std::env::var_os("CLI_MANAGER_SSH_ASKPASS").is_some() {
        cli_manager::ssh_askpass::run_helper_and_exit();
    }
    cli_manager::codex_app_server_proxy::run_shim_and_exit(&args);
}
