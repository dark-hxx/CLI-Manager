//! Native Codex app-server shim used by cc-connect on Windows.

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    cli_manager_lib::codex_app_server_proxy::run_shim_and_exit(&args);
}
