fn main() {
    if let Err(error) = cli_manager::web_daemon::run_daemon() {
        eprintln!("cli-manager-web-daemon: {error}");
        std::process::exit(1);
    }
}
