use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use toml::Value as TomlValue;

const MAX_DISCOVERY_DEPTH: usize = 32;
const MAX_SKILL_BYTES: u64 = 256 * 1024;
const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SKILL_FILES: usize = 500;
const MAX_SKILL_SCAN_DEPTH: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Pi,
    Grok,
    Opencode,
}

impl AgentKind {
    pub fn executable(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Pi => "pi",
            Self::Grok => "grok",
            Self::Opencode => "opencode",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentKind {
    Local,
    Wsl,
    Ssh,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvidence {
    pub server: String,
    pub success: bool,
    #[serde(default)]
    pub timestamp: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectRequest {
    pub terminal_session_id: String,
    pub cli_session_id: String,
    pub agent: AgentKind,
    pub environment: EnvironmentKind,
    pub cwd: String,
    #[serde(default)]
    pub config_root: Option<String>,
    #[serde(default)]
    pub launch_args: String,
    #[serde(default)]
    pub baseline_config_fingerprint: Option<String>,
    #[serde(default)]
    pub runtime_evidence: Vec<RuntimeEvidence>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub path_label: String,
    pub scope: String,
    pub source_kind: String,
    pub format: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    pub path_label: String,
    pub scope: String,
    pub source_kind: String,
    pub fallback_name: String,
    pub content: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryBundle {
    #[serde(default)]
    pub configs: Vec<ConfigDocument>,
    #[serde(default)]
    pub skills: Vec<SkillDocument>,
    #[serde(default)]
    pub diagnostics: Vec<CapabilityDiagnostic>,
}

#[derive(Clone, Debug)]
pub struct DocumentSpec {
    pub path: PathBuf,
    pub path_label: String,
    pub scope: &'static str,
    pub source_kind: &'static str,
    pub format: &'static str,
}

#[derive(Clone, Debug)]
pub struct SkillRootSpec {
    pub path: PathBuf,
    pub label: String,
    pub scope: &'static str,
    pub source_kind: &'static str,
}

#[derive(Clone, Debug, Default)]
pub struct DiscoveryLayout {
    pub configs: Vec<DocumentSpec>,
    pub skill_roots: Vec<SkillRootSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpActivation {
    Active,
    Disabled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpHealth {
    Healthy,
    Error,
    Checking,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpItem {
    pub name: String,
    pub activation: McpActivation,
    pub health: McpHealth,
    pub source_scope: String,
    pub source_kind: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_evidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSummary {
    pub active: usize,
    pub disabled: usize,
    pub healthy: usize,
    pub error: usize,
    pub checking: usize,
    pub unknown: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillState {
    Available,
    Disabled,
    Denied,
    Shadowed,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillItem {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub state: SkillState,
    pub scope: String,
    pub source_kind: String,
    pub path_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub total: usize,
    pub available: usize,
    pub disabled: usize,
    pub denied: usize,
    pub shadowed: usize,
    pub invalid: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDiagnostic {
    pub code: String,
    pub level: DiagnosticLevel,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BridgeStatus {
    Ready,
    Missing,
    Unsupported,
    UpgradeRequired,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilitySnapshot {
    pub terminal_session_id: String,
    pub cli_session_id: String,
    pub agent: AgentKind,
    pub environment: EnvironmentKind,
    pub captured_at: u64,
    pub config_fingerprint: String,
    pub config_changed: bool,
    pub bridge_status: BridgeStatus,
    pub mcp: Vec<McpItem>,
    pub mcp_summary: McpSummary,
    pub skills: Vec<SkillItem>,
    pub skill_summary: SkillSummary,
    pub diagnostics: Vec<CapabilityDiagnostic>,
}

#[derive(Default)]
struct SkillPolicy {
    disabled: HashSet<String>,
    deny_all: bool,
}

fn path_label(path: &Path, home: &Path, cwd: &Path) -> String {
    if let Ok(relative) = path.strip_prefix(cwd) {
        return format!("project/{}", relative.to_string_lossy().replace('\\', "/"));
    }
    if let Ok(relative) = path.strip_prefix(home) {
        return format!("home/{}", relative.to_string_lossy().replace('\\', "/"));
    }
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config")
        .to_string()
}

fn push_config(
    layout: &mut DiscoveryLayout,
    path: PathBuf,
    home: &Path,
    cwd: &Path,
    scope: &'static str,
    source_kind: &'static str,
    format: &'static str,
) {
    layout.configs.push(DocumentSpec {
        path_label: path_label(&path, home, cwd),
        path,
        scope,
        source_kind,
        format,
    });
}

fn push_skill_root(
    layout: &mut DiscoveryLayout,
    path: PathBuf,
    label: String,
    scope: &'static str,
    source_kind: &'static str,
) {
    if !layout.skill_roots.iter().any(|item| item.path == path) {
        layout.skill_roots.push(SkillRootSpec {
            path,
            label,
            scope,
            source_kind,
        });
    }
}

fn project_ancestors(cwd: &Path) -> Vec<PathBuf> {
    let mut current = Some(cwd.to_path_buf());
    let mut result = Vec::new();
    for _ in 0..MAX_DISCOVERY_DEPTH {
        let Some(path) = current else { break };
        result.push(path.clone());
        if path.join(".git").exists() {
            break;
        }
        current = path.parent().map(Path::to_path_buf);
    }
    result.reverse();
    result
}

pub fn discovery_layout(
    agent: AgentKind,
    home: &Path,
    cwd: &Path,
    config_root: Option<&Path>,
) -> DiscoveryLayout {
    let mut layout = DiscoveryLayout::default();
    let agent_root = config_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| match agent {
            AgentKind::Claude => home.join(".claude"),
            AgentKind::Codex => home.join(".codex"),
            AgentKind::Pi => home.join(".pi").join("agent"),
            AgentKind::Grok => home.join(".grok"),
            AgentKind::Opencode => home.join(".config").join("opencode"),
        });

    match agent {
        AgentKind::Claude => {
            push_config(
                &mut layout,
                home.join(".claude.json"),
                home,
                cwd,
                "user",
                "native",
                "json",
            );
            push_config(
                &mut layout,
                agent_root.join("settings.json"),
                home,
                cwd,
                "user",
                "native",
                "json",
            );
        }
        AgentKind::Codex | AgentKind::Grok => {
            push_config(
                &mut layout,
                agent_root.join("config.toml"),
                home,
                cwd,
                "user",
                "native",
                "toml",
            );
        }
        AgentKind::Opencode => {
            push_config(
                &mut layout,
                agent_root.join("opencode.json"),
                home,
                cwd,
                "user",
                "native",
                "json",
            );
            push_config(
                &mut layout,
                agent_root.join("opencode.jsonc"),
                home,
                cwd,
                "user",
                "native",
                "json",
            );
        }
        AgentKind::Pi => {
            push_config(
                &mut layout,
                home.join(".config").join("mcp").join("mcp.json"),
                home,
                cwd,
                "user",
                "native",
                "json",
            );
            push_config(
                &mut layout,
                home.join(".agents").join("mcp.json"),
                home,
                cwd,
                "user",
                "native",
                "json",
            );
            push_config(
                &mut layout,
                home.join(".agents").join("mcp").join("mcp.json"),
                home,
                cwd,
                "user",
                "native",
                "json",
            );
            push_config(
                &mut layout,
                agent_root.join("mcp.json"),
                home,
                cwd,
                "user",
                "native",
                "json",
            );
        }
    }

    let user_roots: Vec<(PathBuf, &str)> = match agent {
        AgentKind::Claude => vec![
            (home.join(".agents/skills"), "agent-compatible"),
            (agent_root.join("plugins/cache"), "plugin"),
            (agent_root.join("skills"), "native"),
        ],
        AgentKind::Codex => vec![
            (home.join(".agents/skills"), "agent-compatible"),
            (agent_root.join("plugins/cache"), "plugin"),
            (agent_root.join("skills"), "native"),
        ],
        AgentKind::Pi => vec![
            (home.join(".agents/skills"), "agent-compatible"),
            (agent_root.join("skills"), "native"),
        ],
        AgentKind::Grok => vec![
            (home.join(".claude/skills"), "claude-compatible"),
            (home.join(".agents/skills"), "agent-compatible"),
            (agent_root.join("skills"), "native"),
        ],
        AgentKind::Opencode => vec![
            (home.join(".claude/skills"), "claude-compatible"),
            (home.join(".agents/skills"), "agent-compatible"),
            (agent_root.join("skills"), "native"),
        ],
    };
    for (path, kind) in user_roots {
        let label = path_label(&path, home, cwd);
        push_skill_root(&mut layout, path, label, "user", kind);
    }

    for ancestor in project_ancestors(cwd) {
        match agent {
            AgentKind::Claude => {
                push_config(
                    &mut layout,
                    ancestor.join(".mcp.json"),
                    home,
                    cwd,
                    "project",
                    "native",
                    "json",
                );
                push_config(
                    &mut layout,
                    ancestor.join(".claude/settings.json"),
                    home,
                    cwd,
                    "project",
                    "native",
                    "json",
                );
            }
            AgentKind::Codex => push_config(
                &mut layout,
                ancestor.join(".codex/config.toml"),
                home,
                cwd,
                "project",
                "native",
                "toml",
            ),
            AgentKind::Grok => push_config(
                &mut layout,
                ancestor.join(".grok/config.toml"),
                home,
                cwd,
                "project",
                "native",
                "toml",
            ),
            AgentKind::Opencode => {
                push_config(
                    &mut layout,
                    ancestor.join("opencode.json"),
                    home,
                    cwd,
                    "project",
                    "native",
                    "json",
                );
                push_config(
                    &mut layout,
                    ancestor.join(".opencode/opencode.json"),
                    home,
                    cwd,
                    "project",
                    "native",
                    "json",
                );
            }
            AgentKind::Pi => {
                push_config(
                    &mut layout,
                    ancestor.join(".mcp.json"),
                    home,
                    cwd,
                    "project",
                    "native",
                    "json",
                );
                push_config(
                    &mut layout,
                    ancestor.join(".pi").join("mcp.json"),
                    home,
                    cwd,
                    "project",
                    "native",
                    "json",
                );
            }
        }
        let project_roots: Vec<(PathBuf, &str)> = match agent {
            AgentKind::Claude => vec![
                (ancestor.join(".agents/skills"), "agent-compatible"),
                (ancestor.join(".claude/skills"), "native"),
            ],
            AgentKind::Codex => vec![(ancestor.join(".agents/skills"), "native")],
            AgentKind::Pi => vec![
                (ancestor.join(".agents/skills"), "agent-compatible"),
                (ancestor.join(".pi/skills"), "native"),
            ],
            AgentKind::Grok => vec![
                (ancestor.join(".claude/skills"), "claude-compatible"),
                (ancestor.join(".cursor/skills"), "cursor-compatible"),
                (ancestor.join(".agents/skills"), "agent-compatible"),
                (ancestor.join(".grok/skills"), "native"),
            ],
            AgentKind::Opencode => vec![
                (ancestor.join(".claude/skills"), "claude-compatible"),
                (ancestor.join(".agents/skills"), "agent-compatible"),
                (ancestor.join(".opencode/skills"), "native"),
            ],
        };
        for (path, kind) in project_roots {
            let label = path_label(&path, home, cwd);
            push_skill_root(&mut layout, path, label, "project", kind);
        }
    }
    layout
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<String, &'static str> {
    let metadata = fs::metadata(path).map_err(|_| "source_unreadable")?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err("source_invalid");
    }
    fs::read_to_string(path).map_err(|_| "source_unreadable")
}

pub fn collect_local_bundle(layout: &DiscoveryLayout) -> DiscoveryBundle {
    let mut bundle = DiscoveryBundle::default();
    for spec in &layout.configs {
        if !spec.path.is_file() {
            continue;
        }
        match read_bounded(&spec.path, MAX_CONFIG_BYTES) {
            Ok(content) => bundle.configs.push(ConfigDocument {
                path_label: spec.path_label.clone(),
                scope: spec.scope.to_string(),
                source_kind: spec.source_kind.to_string(),
                format: spec.format.to_string(),
                content,
            }),
            Err(code) => bundle.diagnostics.push(CapabilityDiagnostic {
                code: code.to_string(),
                level: DiagnosticLevel::Warning,
            }),
        }
    }
    for root in &layout.skill_roots {
        if !root.path.exists() {
            continue;
        }
        let mut pending = vec![(root.path.clone(), 0usize)];
        let mut skill_paths = Vec::new();
        while let Some((directory, depth)) = pending.pop() {
            let entries = match fs::read_dir(&directory) {
                Ok(value) => value,
                Err(_) => {
                    bundle.diagnostics.push(CapabilityDiagnostic {
                        code: "skill_root_unreadable".to_string(),
                        level: DiagnosticLevel::Warning,
                    });
                    continue;
                }
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if file_type.is_file()
                    && path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md")
                {
                    skill_paths.push(path);
                    if skill_paths.len() >= MAX_SKILL_FILES {
                        break;
                    }
                } else if file_type.is_dir() && depth < MAX_SKILL_SCAN_DEPTH {
                    pending.push((path, depth + 1));
                }
            }
            if skill_paths.len() >= MAX_SKILL_FILES {
                break;
            }
        }
        skill_paths.sort();
        for skill_path in skill_paths {
            let fallback_name = skill_path
                .parent()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str())
                .unwrap_or("skill")
                .to_string();
            let relative = skill_path
                .strip_prefix(&root.path)
                .unwrap_or(&skill_path)
                .to_string_lossy()
                .replace('\\', "/");
            match read_bounded(&skill_path, MAX_SKILL_BYTES) {
                Ok(content) => bundle.skills.push(SkillDocument {
                    path_label: format!("{}/{relative}", root.label),
                    scope: root.scope.to_string(),
                    source_kind: root.source_kind.to_string(),
                    fallback_name,
                    content,
                }),
                Err(code) => bundle.skills.push(SkillDocument {
                    path_label: format!("{}/{relative}", root.label),
                    scope: root.scope.to_string(),
                    source_kind: root.source_kind.to_string(),
                    fallback_name,
                    content: format!("__CLI_MANAGER_ERROR__:{code}"),
                }),
            }
        }
    }
    bundle
}

fn json_comments_removed(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if in_string {
            result.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            result.push(ch);
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            for next in chars.by_ref() {
                if next == '\n' {
                    result.push('\n');
                    break;
                }
            }
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut previous = '\0';
            for next in chars.by_ref() {
                if next == '\n' {
                    result.push('\n');
                }
                if previous == '*' && next == '/' {
                    break;
                }
                previous = next;
            }
            continue;
        }
        result.push(ch);
    }
    let mut without_trailing_commas = String::with_capacity(result.len());
    let mut input = result.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(ch) = input.next() {
        if in_string {
            without_trailing_commas.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            without_trailing_commas.push(ch);
            continue;
        }
        if ch != ',' {
            without_trailing_commas.push(ch);
            continue;
        }
        let mut whitespace = String::new();
        while input.peek().is_some_and(|next| next.is_whitespace()) {
            whitespace.push(input.next().unwrap_or_default());
        }
        if !matches!(input.peek().copied(), Some('}') | Some(']')) {
            without_trailing_commas.push(',');
        }
        without_trailing_commas.push_str(&whitespace);
    }
    without_trailing_commas
}

fn transport_from_json(value: &JsonValue) -> String {
    if value.get("url").and_then(JsonValue::as_str).is_some()
        || value
            .get("type")
            .and_then(JsonValue::as_str)
            .is_some_and(|kind| kind.eq_ignore_ascii_case("remote"))
    {
        "remote".to_string()
    } else {
        value
            .get("type")
            .and_then(JsonValue::as_str)
            .filter(|kind| !kind.is_empty())
            .unwrap_or("stdio")
            .to_string()
    }
}

fn collect_json_mcp(
    agent: AgentKind,
    document: &ConfigDocument,
    root: &JsonValue,
    target: &mut BTreeMap<String, McpItem>,
    policy: &mut SkillPolicy,
) {
    let key = match agent {
        AgentKind::Opencode => "mcp",
        AgentKind::Claude => "mcpServers",
        _ => "mcpServers",
    };
    if let Some(servers) = root.get(key).and_then(JsonValue::as_object) {
        for (name, value) in servers {
            let enabled = if agent == AgentKind::Pi {
                !value
                    .get("disabled")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false)
            } else {
                value
                    .get("enabled")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(true)
            };
            target.insert(
                name.to_lowercase(),
                McpItem {
                    name: name.clone(),
                    activation: if enabled {
                        McpActivation::Active
                    } else {
                        McpActivation::Disabled
                    },
                    health: McpHealth::Unknown,
                    source_scope: document.scope.clone(),
                    source_kind: document.source_kind.clone(),
                    transport: transport_from_json(value),
                    last_evidence: None,
                    error_code: None,
                },
            );
        }
    }
    if agent == AgentKind::Opencode {
        if root
            .pointer("/permission/skill")
            .and_then(JsonValue::as_str)
            == Some("deny")
        {
            policy.deny_all = true;
        }
    }
    if let Some(disabled) = root
        .pointer("/skills/disabled")
        .and_then(JsonValue::as_array)
    {
        for name in disabled.iter().filter_map(JsonValue::as_str) {
            policy.disabled.insert(name.to_lowercase());
        }
    }
}

fn toml_transport(value: &TomlValue) -> String {
    if value.get("url").and_then(TomlValue::as_str).is_some() {
        "remote".to_string()
    } else {
        value
            .get("type")
            .and_then(TomlValue::as_str)
            .filter(|kind| !kind.is_empty())
            .unwrap_or("stdio")
            .to_string()
    }
}

fn collect_toml_mcp(
    document: &ConfigDocument,
    root: &TomlValue,
    target: &mut BTreeMap<String, McpItem>,
    policy: &mut SkillPolicy,
) {
    if let Some(servers) = root.get("mcp_servers").and_then(TomlValue::as_table) {
        for (name, value) in servers {
            let enabled = value
                .get("enabled")
                .and_then(TomlValue::as_bool)
                .unwrap_or(true);
            target.insert(
                name.to_lowercase(),
                McpItem {
                    name: name.clone(),
                    activation: if enabled {
                        McpActivation::Active
                    } else {
                        McpActivation::Disabled
                    },
                    health: McpHealth::Unknown,
                    source_scope: document.scope.clone(),
                    source_kind: document.source_kind.clone(),
                    transport: toml_transport(value),
                    last_evidence: None,
                    error_code: None,
                },
            );
        }
    }
    if let Some(disabled) = root
        .get("skills")
        .and_then(|skills| skills.get("disabled"))
        .and_then(TomlValue::as_array)
    {
        for name in disabled.iter().filter_map(TomlValue::as_str) {
            policy.disabled.insert(name.to_lowercase());
        }
    }
}

fn parse_frontmatter(content: &str, fallback_name: &str) -> (String, Option<String>, bool) {
    if let Some(code) = content.strip_prefix("__CLI_MANAGER_ERROR__:") {
        return (fallback_name.to_string(), None, code.trim().is_empty());
    }
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (fallback_name.to_string(), None, false);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("name:") {
            name = Some(value.trim().trim_matches(['\'', '"']).to_string());
        }
        if let Some(value) = line.strip_prefix("description:") {
            description = Some(value.trim().trim_matches(['\'', '"']).to_string());
        }
    }
    let valid = name.as_ref().is_some_and(|value| !value.trim().is_empty());
    (
        name.filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback_name.to_string()),
        description.filter(|value| !value.is_empty()),
        valid,
    )
}

fn summarize_mcp(items: &[McpItem]) -> McpSummary {
    let mut summary = McpSummary::default();
    for item in items {
        if item.activation == McpActivation::Disabled {
            summary.disabled += 1;
            continue;
        }
        summary.active += 1;
        match item.health {
            McpHealth::Healthy => summary.healthy += 1,
            McpHealth::Error => summary.error += 1,
            McpHealth::Checking => summary.checking += 1,
            McpHealth::Unknown => summary.unknown += 1,
        }
    }
    summary
}

fn summarize_skills(items: &[SkillItem]) -> SkillSummary {
    let mut summary = SkillSummary {
        total: items.len(),
        ..SkillSummary::default()
    };
    for item in items {
        match item.state {
            SkillState::Available => summary.available += 1,
            SkillState::Disabled => summary.disabled += 1,
            SkillState::Denied => summary.denied += 1,
            SkillState::Shadowed => summary.shadowed += 1,
            SkillState::Invalid => summary.invalid += 1,
        }
    }
    summary
}

fn fingerprint(bundle: &DiscoveryBundle) -> String {
    let mut hasher = Sha256::new();
    for document in &bundle.configs {
        hasher.update(document.path_label.as_bytes());
        hasher.update([0]);
        hasher.update(document.content.as_bytes());
        hasher.update([0xff]);
    }
    format!("sha256:{:x}", hasher.finalize())
}

pub fn assemble_snapshot(
    request: InspectRequest,
    mut bundle: DiscoveryBundle,
) -> AgentCapabilitySnapshot {
    let config_fingerprint = fingerprint(&bundle);
    let mut mcp_map = BTreeMap::new();
    let mut policy = SkillPolicy::default();
    for document in &bundle.configs {
        match document.format.as_str() {
            "json" => {
                match serde_json::from_str::<JsonValue>(&json_comments_removed(&document.content)) {
                    Ok(root) => {
                        collect_json_mcp(request.agent, document, &root, &mut mcp_map, &mut policy)
                    }
                    Err(_) => bundle.diagnostics.push(CapabilityDiagnostic {
                        code: "config_parse_error".to_string(),
                        level: DiagnosticLevel::Warning,
                    }),
                }
            }
            "toml" => match toml::from_str::<TomlValue>(&document.content) {
                Ok(root) => collect_toml_mcp(document, &root, &mut mcp_map, &mut policy),
                Err(_) => bundle.diagnostics.push(CapabilityDiagnostic {
                    code: "config_parse_error".to_string(),
                    level: DiagnosticLevel::Warning,
                }),
            },
            _ => bundle.diagnostics.push(CapabilityDiagnostic {
                code: "config_format_unsupported".to_string(),
                level: DiagnosticLevel::Warning,
            }),
        }
    }

    for evidence in &request.runtime_evidence {
        let key = evidence.server.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        let item = mcp_map.entry(key).or_insert_with(|| McpItem {
            name: evidence.server.trim().to_string(),
            activation: McpActivation::Active,
            health: McpHealth::Unknown,
            source_scope: "session".to_string(),
            source_kind: "runtime-evidence".to_string(),
            transport: "unknown".to_string(),
            last_evidence: None,
            error_code: None,
        });
        if item.activation == McpActivation::Active {
            item.health = if evidence.success {
                McpHealth::Healthy
            } else {
                McpHealth::Error
            };
            item.last_evidence = evidence.timestamp.clone();
            item.error_code = (!evidence.success).then(|| "session_mcp_call_failed".to_string());
        }
    }

    let disable_all = request
        .launch_args
        .split_whitespace()
        .any(|arg| arg == "--no-skills");
    let mut skills = bundle
        .skills
        .into_iter()
        .map(|document| {
            let explicit_error = document
                .content
                .strip_prefix("__CLI_MANAGER_ERROR__:")
                .map(str::trim);
            let (name, description, valid) =
                parse_frontmatter(&document.content, &document.fallback_name);
            let normalized = name.to_lowercase();
            let state = if explicit_error.is_some() || !valid {
                SkillState::Invalid
            } else if policy.deny_all {
                SkillState::Denied
            } else if disable_all || policy.disabled.contains(&normalized) {
                SkillState::Disabled
            } else {
                SkillState::Available
            };
            SkillItem {
                name,
                description,
                state,
                scope: document.scope,
                source_kind: document.source_kind,
                path_label: document.path_label,
                error_code: explicit_error
                    .map(str::to_string)
                    .or_else(|| (!valid).then(|| "skill_manifest_invalid".to_string())),
            }
        })
        .collect::<Vec<_>>();
    let mut effective = HashSet::new();
    for item in skills.iter_mut().rev() {
        if item.state != SkillState::Available {
            continue;
        }
        if !effective.insert(item.name.to_lowercase()) {
            item.state = SkillState::Shadowed;
        }
    }
    skills.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then(left.path_label.cmp(&right.path_label))
    });
    let mut mcp = mcp_map.into_values().collect::<Vec<_>>();
    mcp.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    if request.agent == AgentKind::Pi && mcp.is_empty() {
        bundle.diagnostics.push(CapabilityDiagnostic {
            code: "pi_mcp_extension_observability_unknown".to_string(),
            level: DiagnosticLevel::Info,
        });
    }
    let captured_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    AgentCapabilitySnapshot {
        terminal_session_id: request.terminal_session_id,
        cli_session_id: request.cli_session_id.clone(),
        agent: request.agent,
        environment: request.environment,
        captured_at,
        config_changed: request
            .baseline_config_fingerprint
            .as_deref()
            .is_some_and(|baseline| baseline != config_fingerprint),
        config_fingerprint,
        bridge_status: if request.cli_session_id.trim().is_empty() {
            BridgeStatus::Missing
        } else {
            BridgeStatus::Ready
        },
        mcp_summary: summarize_mcp(&mcp),
        skill_summary: summarize_skills(&skills),
        mcp,
        skills,
        diagnostics: bundle.diagnostics,
    }
}

fn probe_status_from_text(line: &str) -> Option<McpHealth> {
    let lower = line.to_lowercase();
    if [
        "error",
        "failed",
        "disconnected",
        "unauthenticated",
        "auth required",
        "✗",
        "×",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return Some(McpHealth::Error);
    }
    if [
        "connected",
        "ready",
        "healthy",
        "authenticated",
        "online",
        "✓",
        "√",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return Some(McpHealth::Healthy);
    }
    None
}

fn probe_records(value: &JsonValue) -> Vec<&JsonValue> {
    if let Some(array) = value.as_array() {
        return array.iter().collect();
    }
    for key in ["servers", "mcpServers", "items", "data"] {
        if let Some(array) = value.get(key).and_then(JsonValue::as_array) {
            return array.iter().collect();
        }
    }
    Vec::new()
}

pub fn apply_probe_output(
    snapshot: &mut AgentCapabilitySnapshot,
    output: &str,
    command_succeeded: bool,
) {
    if !command_succeeded {
        snapshot.diagnostics.push(CapabilityDiagnostic {
            code: "agent_probe_failed".to_string(),
            level: DiagnosticLevel::Warning,
        });
        return;
    }
    let mut observed = HashMap::<String, McpHealth>::new();
    let parsed_json = if let Ok(json) = serde_json::from_str::<JsonValue>(output) {
        for record in probe_records(&json) {
            let name = record
                .get("name")
                .or_else(|| record.get("id"))
                .and_then(JsonValue::as_str);
            let Some(name) = name else { continue };
            let enabled = record
                .get("enabled")
                .and_then(JsonValue::as_bool)
                .unwrap_or(true);
            if !enabled {
                continue;
            }
            let status = record
                .get("status")
                .or_else(|| record.get("state"))
                .or_else(|| record.get("authStatus"))
                // Codex CLI emits this field as snake_case in `mcp list --json`.
                .or_else(|| record.get("auth_status"))
                .and_then(JsonValue::as_str)
                .and_then(probe_status_from_text)
                .unwrap_or(McpHealth::Unknown);
            observed.insert(name.to_lowercase(), status);
        }
        true
    } else {
        false
    };
    if !parsed_json {
        for line in output.lines() {
            if let Some(status) = probe_status_from_text(line) {
                for item in &snapshot.mcp {
                    if line.to_lowercase().contains(&item.name.to_lowercase()) {
                        observed.insert(item.name.to_lowercase(), status.clone());
                    }
                }
            }
        }
    }
    for item in &mut snapshot.mcp {
        if item.activation == McpActivation::Disabled {
            continue;
        }
        if let Some(status) = observed.get(&item.name.to_lowercase()) {
            item.health = status.clone();
            item.error_code =
                (item.health == McpHealth::Error).then(|| "agent_reported_mcp_error".to_string());
        }
    }
    snapshot.mcp_summary = summarize_mcp(&snapshot.mcp);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(agent: AgentKind) -> InspectRequest {
        InspectRequest {
            terminal_session_id: "tab-1".into(),
            cli_session_id: "session-1".into(),
            agent,
            environment: EnvironmentKind::Local,
            cwd: "/repo".into(),
            config_root: None,
            launch_args: String::new(),
            baseline_config_fingerprint: None,
            runtime_evidence: Vec::new(),
        }
    }

    #[test]
    fn static_config_is_active_but_unknown() {
        let bundle = DiscoveryBundle {
            configs: vec![ConfigDocument {
                path_label: "project/opencode.json".into(),
                scope: "project".into(),
                source_kind: "native".into(),
                format: "json".into(),
                content: r#"{"mcp":{"docs":{"type":"remote","url":"https://secret.example","enabled":true}}}"#.into(),
            }],
            ..DiscoveryBundle::default()
        };
        let snapshot = assemble_snapshot(request(AgentKind::Opencode), bundle);
        assert_eq!(snapshot.mcp_summary.active, 1);
        assert_eq!(snapshot.mcp_summary.unknown, 1);
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("secret.example"));
    }

    #[test]
    fn pi_adapter_configs_follow_their_documented_precedence() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(cwd.join(".git")).unwrap();

        let layout = discovery_layout(AgentKind::Pi, &home, &cwd, None);
        let paths = layout
            .configs
            .iter()
            .map(|config| config.path.clone())
            .collect::<Vec<_>>();

        assert_eq!(
            paths,
            vec![
                home.join(".config").join("mcp").join("mcp.json"),
                home.join(".agents").join("mcp.json"),
                home.join(".agents").join("mcp").join("mcp.json"),
                home.join(".pi").join("agent").join("mcp.json"),
                cwd.join(".mcp.json"),
                cwd.join(".pi").join("mcp.json"),
            ]
        );
    }

    #[test]
    fn pi_adapter_config_reports_active_and_disabled_mcp_without_unknown_diagnostic() {
        let bundle = DiscoveryBundle {
            configs: vec![ConfigDocument {
                path_label: "home/.pi/agent/mcp.json".into(),
                scope: "user".into(),
                source_kind: "native".into(),
                format: "json".into(),
                content: r#"{
                  "mcpServers": {
                    "enabled-server": { "type": "stdio", "command": "secret-command" },
                    "disabled-server": { "disabled": true, "command": "another-secret" }
                  }
                }"#
                .into(),
            }],
            ..DiscoveryBundle::default()
        };

        let snapshot = assemble_snapshot(request(AgentKind::Pi), bundle);

        assert_eq!(snapshot.mcp_summary.active, 1);
        assert_eq!(snapshot.mcp_summary.disabled, 1);
        assert_eq!(snapshot.mcp_summary.unknown, 1);
        assert!(!snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pi_mcp_extension_observability_unknown"));
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains("secret-command"));
        assert!(!serialized.contains("another-secret"));
    }

    #[test]
    fn complete_toml_documents_are_parsed_without_false_diagnostics() {
        let bundle = DiscoveryBundle {
            configs: vec![
                ConfigDocument {
                    path_label: "home/.codex/config.toml".into(),
                    scope: "user".into(),
                    source_kind: "native".into(),
                    format: "toml".into(),
                    content: r#"model_provider = "custom"

[mcp_servers.user_docs]
command = "docs"
"#
                    .into(),
                },
                ConfigDocument {
                    path_label: "project/.codex/config.toml".into(),
                    scope: "project".into(),
                    source_kind: "native".into(),
                    format: "toml".into(),
                    content: r#"# Project-scoped Codex configuration
[mcp_servers.project_git]
command = "git"
"#
                    .into(),
                },
            ],
            ..DiscoveryBundle::default()
        };

        let snapshot = assemble_snapshot(request(AgentKind::Codex), bundle);

        assert_eq!(snapshot.mcp_summary.active, 2);
        assert!(!snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "config_parse_error"));
    }

    #[test]
    fn invalid_toml_document_still_reports_parse_error() {
        let bundle = DiscoveryBundle {
            configs: vec![ConfigDocument {
                path_label: "home/.codex/config.toml".into(),
                scope: "user".into(),
                source_kind: "native".into(),
                format: "toml".into(),
                content: "[mcp_servers.invalid".into(),
            }],
            ..DiscoveryBundle::default()
        };

        let snapshot = assemble_snapshot(request(AgentKind::Codex), bundle);

        assert!(snapshot
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "config_parse_error"));
    }

    #[test]
    fn codex_probe_reads_snake_case_auth_status() {
        let bundle = DiscoveryBundle {
            configs: vec![ConfigDocument {
                path_label: "home/.codex/config.toml".into(),
                scope: "user".into(),
                source_kind: "native".into(),
                format: "toml".into(),
                content: r#"
[mcp_servers.authenticated]
command = "auth"

[mcp_servers.unauthenticated]
command = "login"

[mcp_servers.stdio]
command = "local"
"#
                .into(),
            }],
            ..DiscoveryBundle::default()
        };
        let mut snapshot = assemble_snapshot(request(AgentKind::Codex), bundle);

        apply_probe_output(
            &mut snapshot,
            r#"[
              {"name":"authenticated","enabled":true,"auth_status":"authenticated"},
              {"name":"unauthenticated","enabled":true,"auth_status":"unauthenticated"},
              {"name":"stdio","enabled":true,"auth_status":"unsupported"}
            ]"#,
            true,
        );

        assert_eq!(snapshot.mcp_summary.healthy, 1);
        assert_eq!(snapshot.mcp_summary.error, 1);
        assert_eq!(snapshot.mcp_summary.unknown, 1);
        assert_eq!(
            snapshot
                .mcp
                .iter()
                .find(|item| item.name == "unauthenticated")
                .and_then(|item| item.error_code.as_deref()),
            Some("agent_reported_mcp_error")
        );
    }

    #[test]
    fn disabled_and_shadowed_skills_are_preserved() {
        let manifest = |name: &str| format!("---\nname: {name}\ndescription: test\n---\n");
        let bundle = DiscoveryBundle {
            skills: vec![
                SkillDocument {
                    path_label: "home/a/SKILL.md".into(),
                    scope: "user".into(),
                    source_kind: "native".into(),
                    fallback_name: "a".into(),
                    content: manifest("same"),
                },
                SkillDocument {
                    path_label: "project/a/SKILL.md".into(),
                    scope: "project".into(),
                    source_kind: "native".into(),
                    fallback_name: "a".into(),
                    content: manifest("same"),
                },
            ],
            ..DiscoveryBundle::default()
        };
        let snapshot = assemble_snapshot(request(AgentKind::Codex), bundle);
        assert_eq!(snapshot.skill_summary.available, 1);
        assert_eq!(snapshot.skill_summary.shadowed, 1);
    }

    #[test]
    fn runtime_failure_marks_only_the_matching_server() {
        let mut req = request(AgentKind::Claude);
        req.runtime_evidence.push(RuntimeEvidence {
            server: "docs".into(),
            success: false,
            timestamp: Some("now".into()),
        });
        let snapshot = assemble_snapshot(req, DiscoveryBundle::default());
        assert_eq!(snapshot.mcp_summary.error, 1);
        assert_eq!(
            snapshot.mcp[0].error_code.as_deref(),
            Some("session_mcp_call_failed")
        );
    }

    #[test]
    fn jsonc_comments_and_trailing_commas_preserve_string_content() {
        let normalized = json_comments_removed(
            r#"{
              // comment
              "mcp": {
                "docs": { "url": "https://example.test/a,}", },
              },
            }"#,
        );
        let parsed: JsonValue = serde_json::from_str(&normalized).unwrap();
        assert_eq!(
            parsed.pointer("/mcp/docs/url").and_then(JsonValue::as_str),
            Some("https://example.test/a,}")
        );
    }

    #[test]
    fn nested_plugin_skill_is_discovered_without_following_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let skill = temp
            .path()
            .join("plugins/cache/vendor/plugin/1.0.0/skills/nested/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        fs::write(&skill, "---\nname: nested\ndescription: plugin\n---\n").unwrap();
        let layout = DiscoveryLayout {
            configs: Vec::new(),
            skill_roots: vec![SkillRootSpec {
                path: temp.path().join("plugins/cache"),
                label: "home/plugins/cache".into(),
                scope: "user",
                source_kind: "plugin",
            }],
        };
        let bundle = collect_local_bundle(&layout);
        assert_eq!(bundle.skills.len(), 1);
        assert_eq!(bundle.skills[0].source_kind, "plugin");
        assert!(bundle.skills[0]
            .path_label
            .ends_with("skills/nested/SKILL.md"));
    }
}
