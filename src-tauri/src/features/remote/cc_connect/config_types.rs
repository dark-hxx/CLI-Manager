use super::CcConnectAgent;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
pub(super) struct ManagedConfig {
    pub(super) data_dir: String,
    pub(super) language: String,
    pub(super) max_turn_time_mins: u32,
    pub(super) queue: ManagedQueueConfig,
    pub(super) rate_limit: ManagedRateLimitConfig,
    pub(super) log: ManagedLogConfig,
    pub(super) webhook: DisabledFeature,
    pub(super) bridge: DisabledFeature,
    pub(super) management: DisabledFeature,
    pub(super) commands: Vec<ManagedCommand>,
    pub(super) aliases: Vec<ManagedAlias>,
    pub(super) projects: Vec<ManagedProject>,
}
#[derive(Serialize)]
pub(super) struct ManagedLogConfig {
    pub(super) level: String,
}
#[derive(Serialize)]
pub(super) struct ManagedQueueConfig {
    pub(super) max_depth: u32,
}
#[derive(Serialize)]
pub(super) struct ManagedRateLimitConfig {
    pub(super) max_messages: u32,
    pub(super) window_secs: u32,
}
#[derive(Serialize)]
pub(super) struct DisabledFeature {
    pub(super) enabled: bool,
}
#[derive(Serialize)]
pub(super) struct ManagedProject {
    pub(super) name: String,
    pub(super) admin_from: String,
    pub(super) disabled_commands: Vec<String>,
    pub(super) reset_on_idle_mins: u32,
    pub(super) agent: ManagedAgent,
    pub(super) platforms: Vec<ManagedPlatform>,
}
#[derive(Serialize)]
pub(super) struct ManagedAgent {
    #[serde(rename = "type")]
    pub(super) kind: String,
    pub(super) options: ManagedAgentOptions,
}
#[derive(Serialize)]
pub(super) struct ManagedAgentOptions {
    pub(super) work_dir: String,
    pub(super) mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cmd: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) app_server_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) codex_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) rpc: Option<bool>,
    pub(super) env: BTreeMap<String, String>,
}
#[derive(Serialize)]
pub(super) struct CodexModelDiscoveryConfig<'a> {
    pub(super) model_catalog_json: &'a str,
}
#[derive(Serialize)]
pub(super) struct CodexModelCatalog {
    pub(super) models: Vec<serde_json::Value>,
}
#[derive(Serialize)]
pub(super) struct ManagedPlatform {
    #[serde(rename = "type")]
    pub(super) kind: String,
    pub(super) options: BTreeMap<String, toml::Value>,
}

#[derive(Serialize)]
pub(super) struct ManagedCommand {
    pub(super) name: String,
    pub(super) description: String,
    pub(super) exec: String,
    pub(super) work_dir: String,
}

#[derive(Serialize)]
pub(super) struct ManagedAlias {
    pub(super) name: String,
    pub(super) command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RegisteredProject {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) path: String,
    pub(super) agent: CcConnectAgent,
    pub(super) cli_tool: String,
    pub(super) cli_args: String,
    pub(super) group_path: Vec<RegisteredGroupSegment>,
    pub(super) provider_id: Option<String>,
    pub(super) codex_provider_id: Option<String>,
    pub(super) provider_name: Option<String>,
    pub(super) provider_is_global: bool,
    pub(super) environment_type: String,
    pub(super) ssh_host_id: Option<String>,
    pub(super) remote_path: String,
    pub(super) cli_config_root: String,
    pub(super) env_vars: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RegisteredGroupSegment {
    pub(super) id: String,
    pub(super) name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RegisteredGroup {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) parent_id: Option<String>,
    pub(super) sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RegisteredProjectRow {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) path: String,
    pub(super) agent: CcConnectAgent,
    pub(super) cli_tool: String,
    pub(super) cli_args: String,
    pub(super) group_id: Option<String>,
    pub(super) sort_order: i64,
    pub(super) provider_overrides: String,
    pub(super) environment_type: String,
    pub(super) ssh_host_id: Option<String>,
    pub(super) remote_path: String,
    pub(super) cli_config_root: String,
    pub(super) host_codex_config_root: String,
    pub(super) env_vars: String,
}

#[derive(Debug, Clone)]
pub(super) struct RegisteredSshHost {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) username: String,
    pub(super) config_alias: String,
    pub(super) config_file: String,
    pub(super) auth_mode: String,
    pub(super) identity_file: String,
    pub(super) credential_ref: String,
    pub(super) jump_mode: String,
    pub(super) jump_host_id: Option<String>,
    pub(super) proxy_type: String,
    pub(super) proxy_host: String,
    pub(super) proxy_port: u16,
    pub(super) proxy_command: String,
    pub(super) connect_timeout_sec: u64,
    pub(super) server_alive_interval_sec: u64,
    pub(super) server_alive_count_max: u32,
    pub(super) startup_script: String,
}

#[derive(Debug, Default)]
pub(super) struct ProviderCatalog {
    pub(super) current_by_app: BTreeMap<String, ProviderCatalogEntry>,
    pub(super) names_by_app_and_id: BTreeMap<(String, String), String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ProviderCatalogEntry {
    pub(super) id: String,
    pub(super) name: String,
}
