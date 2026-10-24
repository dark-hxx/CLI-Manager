use cli_manager::app_paths::cli_manager_data_dir;
use cli_manager::daemon::discovery::daemon_info_path;
use cli_manager::daemon::server::{DaemonServer, DaemonServerConfig};
use cli_manager::daemon::setup_process_governance;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if cli_manager::ssh_proxy::is_helper_request(&args) {
        cli_manager::ssh_proxy::run_helper_and_exit(&args);
    }
    if std::env::var_os("CLI_MANAGER_SSH_ASKPASS").is_some() {
        cli_manager::ssh_askpass::run_helper_and_exit();
    }
    let _ = simple_stderr_logger::init();
    setup_process_governance();
    let data_dir = match cli_manager_data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("cli-manager-daemon: data dir unavailable: {err}");
            std::process::exit(1);
        }
    };
    let config = DaemonServerConfig {
        info_path: daemon_info_path(&data_dir, cfg!(debug_assertions)),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    if let Err(err) = DaemonServer::run(config) {
        eprintln!("cli-manager-daemon: {err}");
        std::process::exit(1);
    }
}

mod simple_stderr_logger {
    use log::{Level, Log, Metadata, Record};

    struct StderrLogger;

    impl Log for StderrLogger {
        fn enabled(&self, metadata: &Metadata) -> bool {
            metadata.level() <= Level::Info
        }

        fn log(&self, record: &Record) {
            if self.enabled(record.metadata()) {
                eprintln!("[{}] {}", record.level(), record.args());
            }
        }

        fn flush(&self) {}
    }

    static LOGGER: StderrLogger = StderrLogger;

    pub fn init() -> Result<(), log::SetLoggerError> {
        log::set_logger(&LOGGER).map(|_| log::set_max_level(log::LevelFilter::Info))
    }
}
