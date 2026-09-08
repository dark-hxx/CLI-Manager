//! `cli-manager-daemon`：PTY 守护进程入口（Issue #123 Phase 2）。
//!
//! 由主应用按需拉起（detached），不接受手工参数；dev/安装版由编译期
//! `debug_assertions` 决定使用 `daemon.dev.json` / `daemon.json`，互不串扰。

use cli_manager_lib::app_paths::cli_manager_data_dir;
use cli_manager_lib::daemon::discovery::daemon_info_path;
use cli_manager_lib::daemon::server::{DaemonServer, DaemonServerConfig};
use cli_manager_lib::daemon::setup_process_governance;

// 优先分流 SSH proxy/askpass helper；普通启动再安装日志与进程治理，按构建类型选择发现文件运行 daemon。
// 数据目录获取或服务运行失败时输出错误并以状态码 1 退出，不执行自动重试。
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if cli_manager_lib::ssh_proxy::is_helper_request(&args) {
        cli_manager_lib::ssh_proxy::run_helper_and_exit(&args);
    }
    if std::env::var_os("CLI_MANAGER_SSH_ASKPASS").is_some() {
        cli_manager_lib::ssh_askpass::run_helper_and_exit();
    }
    // 极简 stderr 日志：daemon 无窗口，detached 模式下 stderr 通常被丢弃，
    // 增量 2 接入文件日志（LogDir/cli-manager-daemon.log）。
    let _ = simple_stderr_logger::init();
    // Job Object 兜底必须最先执行：之后 spawn 的 PTY 子进程才会进 Job。
    setup_process_governance();

    let data_dir = match cli_manager_data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("cli-manager-daemon: data dir unavailable: {err}");
            std::process::exit(1);
        }
    };
    let info_path = daemon_info_path(&data_dir, cfg!(debug_assertions));
    let config = DaemonServerConfig {
        info_path,
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    if let Err(err) = DaemonServer::run(config) {
        // 启动失败最常见原因：已有存活实例持有发现文件（单实例约束）。
        eprintln!("cli-manager-daemon: {err}");
        std::process::exit(1);
    }
}

mod simple_stderr_logger {
    use log::{Level, Metadata, Record};

    struct StderrLogger;

    impl log::Log for StderrLogger {
        // 接受 Info 及更严重级别，排除 Debug 和 Trace。
        fn enabled(&self, metadata: &Metadata) -> bool {
            metadata.level() <= Level::Info
        }
        // 对允许级别直接输出级别与消息到 stderr；不在此脱敏或写入日志文件。
        fn log(&self, record: &Record) {
            if self.enabled(record.metadata()) {
                eprintln!("[{}] {}", record.level(), record.args());
            }
        }
        // 没有额外缓冲需要提交，因此刷新回调为空操作。
        fn flush(&self) {}
    }

    static LOGGER: StderrLogger = StderrLogger;

    // 注册静态全局日志器，成功后设置 Info 上限；已有日志器时返回注册错误。
    pub fn init() -> Result<(), log::SetLoggerError> {
        log::set_logger(&LOGGER).map(|_| log::set_max_level(log::LevelFilter::Info))
    }
}
