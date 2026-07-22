// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if cli_manager_lib::codex_app_server_proxy::is_helper_request(&args) {
        cli_manager_lib::codex_app_server_proxy::run_helper_and_exit(&args);
    }
    if cli_manager_lib::ssh_proxy::is_helper_request(&args) {
        cli_manager_lib::ssh_proxy::run_helper_and_exit(&args);
    }
    if std::env::var_os("CLI_MANAGER_SSH_ASKPASS").is_some() {
        cli_manager_lib::ssh_askpass::run_helper_and_exit();
    }
    // hook 子命令：在初始化 Tauri runtime 之前拦截并退出，避免每次 hook 触发都冷启动 WebView。
    if args.get(1).map(String::as_str) == Some("__hook") {
        let source = arg_value(&args, "--source").unwrap_or_else(|| "claude".to_string());
        let event = arg_value(&args, "--event").unwrap_or_else(|| "Notification".to_string());
        cli_manager_lib::hook_client::run_and_exit(&source, &event);
    }
    if args.get(1).map(String::as_str) == Some("__statusline") {
        cli_manager_lib::statusline::run_and_exit();
    }
    if args.get(1).map(String::as_str) == Some("__daemon") {
        cli_manager_lib::run_daemon_and_exit();
    }
    cli_manager_lib::run()
}

fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .cloned()
}
