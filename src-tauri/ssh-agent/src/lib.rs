pub mod files;
pub mod git;
pub mod history;
pub mod hook_config;
pub mod hook_runtime;
pub mod installer;
pub mod layout;
pub mod protocol;

use serde::Serialize;

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 7;

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

pub fn target_supported() -> bool {
    std::env::consts::OS == "linux" && matches!(std::env::consts::ARCH, "x86_64" | "aarch64")
}

#[cfg(test)]
mod tests {
    use super::{target_supported, version_report};

    #[test]
    fn version_report_uses_the_stable_agent_identity() {
        let report = version_report();
        assert_eq!(report.agent_name, "cli-manager-ssh-agent");
        assert_eq!(report.protocol_major, 1);
        assert_eq!(report.protocol_minor, 7);
    }

    #[test]
    fn target_support_matches_the_first_release_matrix() {
        assert_eq!(
            target_supported(),
            std::env::consts::OS == "linux"
                && matches!(std::env::consts::ARCH, "x86_64" | "aarch64")
        );
    }
}
