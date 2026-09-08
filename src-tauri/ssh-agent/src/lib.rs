pub mod agent_capabilities;
pub mod files;
pub mod git;
mod git_diff;
mod git_history;
mod git_tools;
pub mod history;
pub mod hook_config;
pub mod hook_runtime;
pub mod installer;
pub mod layout;
pub mod protocol;

use serde::Serialize;

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 15;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionReport {
    pub agent_name: &'static str,
    pub agent_version: &'static str,
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub target_os: &'static str,
    pub target_arch: &'static str,
}

// 汇总编译期包版本、独立协议版本及目标平台身份，不探测运行环境或已安装文件。
pub fn version_report() -> VersionReport {
    VersionReport {
        agent_name: "cli-manager-ssh-agent",
        agent_version: AGENT_VERSION,
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        target_os: std::env::consts::OS,
        target_arch: std::env::consts::ARCH,
    }
}

// 按编译目标判断是否属于 Linux x86_64/aarch64 支持矩阵，不代表已验证系统 ABI 或依赖。
pub fn target_supported() -> bool {
    std::env::consts::OS == "linux" && matches!(std::env::consts::ARCH, "x86_64" | "aarch64")
}

#[cfg(test)]
mod tests {
    use super::{target_supported, version_report};

    #[test]
    // 固定断言 Agent 产品身份、当前发布版本和协议版本，防止入口报告漂移。
    fn version_report_uses_the_stable_agent_identity() {
        let report = version_report();
        assert_eq!(report.agent_name, "cli-manager-ssh-agent");
        assert_eq!(report.agent_version, "0.1.14");
        assert_eq!(report.protocol_major, 1);
        assert_eq!(report.protocol_minor, 15);
    }

    #[test]
    // 验证支持标志与当前编译目标是否属于首发 Linux 架构矩阵一致。
    fn target_support_matches_the_first_release_matrix() {
        assert_eq!(
            target_supported(),
            std::env::consts::OS == "linux"
                && matches!(std::env::consts::ARCH, "x86_64" | "aarch64")
        );
    }
}
