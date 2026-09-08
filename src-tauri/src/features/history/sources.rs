use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLocationSlotDescriptor {
    pub id: &'static str,
    pub default_label: &'static str,
    pub purpose: &'static str,
    pub kind: &'static str,
    pub required: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySourceCapabilityDescriptor {
    pub list: &'static str,
    pub search: &'static str,
    pub stats: &'static str,
    pub usage: &'static str,
    pub raw_open: &'static str,
    pub resume: &'static str,
    pub app_open: &'static str,
    pub edit: &'static str,
    pub delete: &'static str,
    pub convert_from: &'static str,
    pub convert_to: &'static str,
    pub realtime_stats: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySourceDescriptor {
    pub id: &'static str,
    pub default_label: &'static str,
    pub aliases: &'static [&'static str],
    pub locations: Vec<HistoryLocationSlotDescriptor>,
    pub capabilities: HistorySourceCapabilityDescriptor,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySourceValidateRequest {
    pub source_id: String,
    pub locations: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySourceValidateResult {
    pub valid: bool,
    pub normalized_locations: BTreeMap<String, String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySourceCandidate {
    pub source_id: &'static str,
    pub location_id: &'static str,
    pub path: String,
    pub environment: HistorySourceEnvironment,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[allow(dead_code)]
pub enum HistorySourceEnvironment {
    Windows,
    Wsl { distro: String },
    Macos,
    Linux,
}

#[derive(Clone, Copy)]
struct SourceSpec {
    id: &'static str,
    default_label: &'static str,
    aliases: &'static [&'static str],
    location: LocationSpec,
    capabilities: CapabilitySpec,
    default_leaf: &'static str,
}

#[derive(Clone, Copy)]
struct LocationSpec {
    id: &'static str,
    default_label: &'static str,
    purpose: &'static str,
    kind: &'static str,
}

#[derive(Clone, Copy)]
struct CapabilitySpec {
    list: &'static str,
    search: &'static str,
    stats: &'static str,
    usage: &'static str,
    raw_open: &'static str,
    resume: &'static str,
    app_open: &'static str,
    edit: &'static str,
    delete: &'static str,
    convert_from: &'static str,
    convert_to: &'static str,
    realtime_stats: &'static str,
}

const SUPPORTED_CLAUDE_CODEX: CapabilitySpec = CapabilitySpec {
    list: "supported",
    search: "supported",
    stats: "supported",
    usage: "supported",
    raw_open: "supported",
    resume: "supported",
    app_open: "planned",
    edit: "planned",
    delete: "planned",
    convert_from: "supported",
    convert_to: "supported",
    realtime_stats: "supported",
};

const FILE_READER: CapabilitySpec = CapabilitySpec {
    list: "planned",
    search: "planned",
    stats: "planned",
    usage: "planned",
    raw_open: "planned",
    resume: "planned",
    app_open: "planned",
    edit: "planned",
    delete: "planned",
    convert_from: "planned",
    convert_to: "planned",
    realtime_stats: "unsupported",
};

const NATIVE_READONLY_FILE: CapabilitySpec = CapabilitySpec {
    list: "supported",
    search: "supported",
    stats: "supported",
    raw_open: "supported",
    resume: "unsupported",
    ..FILE_READER
};

const NATIVE_READONLY_DB: CapabilitySpec = CapabilitySpec {
    list: "supported",
    search: "supported",
    stats: "supported",
    usage: "supported",
    raw_open: "planned",
    resume: "unsupported",
    app_open: "planned",
    edit: "planned",
    delete: "planned",
    convert_from: "planned",
    convert_to: "planned",
    realtime_stats: "unsupported",
};

const CONFIG_ROOT: LocationSpec = LocationSpec {
    id: "configRoot",
    default_label: "Config root",
    purpose: "config",
    kind: "directory",
};

const SESSION_ROOT: LocationSpec = LocationSpec {
    id: "sessionRoot",
    default_label: "Session root",
    purpose: "content",
    kind: "directory",
};

const SESSION_DB: LocationSpec = LocationSpec {
    id: "sessionDb",
    default_label: "Session database",
    purpose: "state",
    kind: "database",
};

const SOURCES: &[SourceSpec] = &[
    SourceSpec {
        id: "claude",
        default_label: "Claude Code",
        aliases: &["claude-code"],
        location: CONFIG_ROOT,
        capabilities: SUPPORTED_CLAUDE_CODEX,
        default_leaf: ".claude",
    },
    SourceSpec {
        id: "codex",
        default_label: "Codex CLI",
        aliases: &[],
        location: CONFIG_ROOT,
        capabilities: SUPPORTED_CLAUDE_CODEX,
        default_leaf: ".codex",
    },
    SourceSpec {
        id: "gemini",
        default_label: "Gemini CLI",
        aliases: &[],
        location: CONFIG_ROOT,
        capabilities: NATIVE_READONLY_FILE,
        default_leaf: ".gemini",
    },
    SourceSpec {
        id: "copilot",
        default_label: "GitHub Copilot CLI",
        aliases: &["copilot-cli"],
        location: SESSION_ROOT,
        capabilities: NATIVE_READONLY_FILE,
        default_leaf: ".copilot/session-state",
    },
    SourceSpec {
        id: "antigravity",
        default_label: "Antigravity",
        aliases: &[],
        location: CONFIG_ROOT,
        capabilities: NATIVE_READONLY_FILE,
        default_leaf: ".gemini/antigravity-cli",
    },
    SourceSpec {
        id: "grok",
        default_label: "Grok Build",
        aliases: &[],
        location: SESSION_ROOT,
        capabilities: CapabilitySpec {
            usage: "supported",
            resume: "supported",
            delete: "supported",
            realtime_stats: "supported",
            ..NATIVE_READONLY_FILE
        },
        default_leaf: ".grok",
    },
    SourceSpec {
        id: "kimi",
        default_label: "Kimi Code",
        aliases: &["kimi-code"],
        location: CONFIG_ROOT,
        capabilities: CapabilitySpec {
            usage: "supported",
            resume: "supported",
            delete: "supported",
            realtime_stats: "supported",
            ..NATIVE_READONLY_FILE
        },
        default_leaf: ".kimi-code",
    },
    SourceSpec {
        id: "pi",
        default_label: "Pi",
        aliases: &[],
        location: SESSION_ROOT,
        capabilities: CapabilitySpec {
            realtime_stats: "supported",
            resume: "supported",
            ..NATIVE_READONLY_FILE
        },
        default_leaf: ".pi",
    },
    SourceSpec {
        id: "opencode",
        default_label: "OpenCode",
        aliases: &[],
        location: SESSION_DB,
        capabilities: CapabilitySpec { resume: "supported", ..NATIVE_READONLY_DB },
        default_leaf: ".local/share/opencode/opencode.db",
    },
    SourceSpec {
        id: "kiro",
        default_label: "Kiro",
        aliases: &["kiro-cli"],
        location: SESSION_ROOT,
        capabilities: NATIVE_READONLY_FILE,
        default_leaf: ".kiro",
    },
    SourceSpec {
        id: "cursor",
        default_label: "Cursor",
        aliases: &[],
        location: SESSION_ROOT,
        capabilities: NATIVE_READONLY_FILE,
        default_leaf: ".cursor/projects",
    },
    SourceSpec {
        id: "cline",
        default_label: "Cline",
        aliases: &[],
        location: SESSION_ROOT,
        capabilities: NATIVE_READONLY_FILE,
        default_leaf: ".cline",
    },
];

#[tauri::command]
// 将静态来源注册表转换为前端可读的位置及能力描述列表。
pub fn history_sources_list_descriptors() -> Vec<HistorySourceDescriptor> {
    SOURCES.iter().map(descriptor_from_spec).collect()
}

#[tauri::command]
// 按可选来源检查默认历史位置，返回存在的候选及环境标识。
pub fn history_sources_detect(
    source_id: Option<String>,
) -> Result<Vec<HistorySourceCandidate>, String> {
    let home = home_dir().ok_or_else(|| "home_dir_unavailable".to_string())?;
    let source_id = source_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut candidates = Vec::new();

    for spec in SOURCES
        .iter()
        .filter(|spec| source_id.is_none_or(|id| id == spec.id))
    {
        let path = default_candidate_path(spec, &home);
        if candidate_exists(&path, spec.location.kind) {
            candidates.push(HistorySourceCandidate {
                source_id: spec.id,
                location_id: spec.location.id,
                path: path_to_string(&path),
                environment: environment_for_path(&path),
                reason: "default_home_location",
            });
        }
    }

    if source_id.is_some()
        && candidates.is_empty()
        && !SOURCES.iter().any(|spec| Some(spec.id) == source_id)
    {
        return Err("history_source_unknown".to_string());
    }

    Ok(candidates)
}

// 优先使用 Provider Home 和 Windows 特定存储位置，否则从用户目录构造候选。
fn default_candidate_path(spec: &SourceSpec, home: &Path) -> PathBuf {
    if let Some(path) = match spec.id {
        "claude" => crate::provider::home::default_config_root("claude"),
        "codex" => crate::provider::home::default_config_root("codex"),
        "grok" => crate::provider::home::default_history_root("grok"),
        _ => None,
    } {
        return path;
    }

    #[cfg(target_os = "windows")]
    if spec.id == "kiro" {
        if let Some(app_data) = std::env::var_os("APPDATA").filter(|value| !value.is_empty()) {
            return PathBuf::from(app_data)
                .join("Kiro")
                .join("User")
                .join("globalStorage")
                .join("kiro.kiroagent")
                .join("workspace-sessions");
        }
    }
    #[cfg(target_os = "windows")]
    if spec.id == "cline" {
        if let Some(app_data) = std::env::var_os("APPDATA").filter(|value| !value.is_empty()) {
            return PathBuf::from(app_data)
                .join("Code")
                .join("User")
                .join("globalStorage")
                .join("saoudrizwan.claude-dev");
        }
    }

    default_candidate_path_from_home(spec, home)
}

// 按来源默认路径拼接用户目录，并为 Grok 追加 sessions。
fn default_candidate_path_from_home(spec: &SourceSpec, home: &Path) -> PathBuf {
    let path = spec
        .default_leaf
        .split('/')
        .fold(home.to_path_buf(), |path, part| path.join(part));
    if spec.id == "grok" {
        path.join("sessions")
    } else {
        path
    }
}

#[tauri::command]
// 校验来源及必需位置，返回规范位置字符串、形状警告和错误。
pub fn history_sources_validate(
    request: HistorySourceValidateRequest,
) -> Result<HistorySourceValidateResult, String> {
    let Some(spec) = SOURCES
        .iter()
        .find(|spec| spec.id == request.source_id.trim())
    else {
        return Err("history_source_unknown".to_string());
    };

    let mut normalized_locations = BTreeMap::new();
    let mut warnings = Vec::new();
    let mut errors = Vec::new();
    let location = spec.location;
    let raw = request
        .locations
        .get(location.id)
        .map(String::as_str)
        .unwrap_or("")
        .trim();

    if raw.is_empty() {
        errors.push(format!("missing_required_location:{}", location.id));
    } else {
        let path = PathBuf::from(raw);
        normalized_locations.insert(location.id.to_string(), path_to_string(&path));
        validate_location(&path, location.kind, location.id, &mut errors);
        validate_source_shape(spec, &path, &mut warnings);
    }

    Ok(HistorySourceValidateResult {
        valid: errors.is_empty(),
        normalized_locations,
        warnings,
        errors,
    })
}

// 将内部来源规格映射为公开能力描述及必填位置槽。
fn descriptor_from_spec(spec: &SourceSpec) -> HistorySourceDescriptor {
    let location = HistoryLocationSlotDescriptor {
        id: spec.location.id,
        default_label: spec.location.default_label,
        purpose: spec.location.purpose,
        kind: spec.location.kind,
        required: true,
    };
    HistorySourceDescriptor {
        id: spec.id,
        default_label: spec.default_label,
        aliases: spec.aliases,
        locations: vec![location],
        capabilities: HistorySourceCapabilityDescriptor {
            list: spec.capabilities.list,
            search: spec.capabilities.search,
            stats: spec.capabilities.stats,
            usage: spec.capabilities.usage,
            raw_open: spec.capabilities.raw_open,
            resume: spec.capabilities.resume,
            app_open: spec.capabilities.app_open,
            edit: spec.capabilities.edit,
            delete: spec.capabilities.delete,
            convert_from: spec.capabilities.convert_from,
            convert_to: spec.capabilities.convert_to,
            realtime_stats: spec.capabilities.realtime_stats,
        },
    }
}

// 按位置类型检查候选存在性并追加相应错误代码。
fn validate_location(path: &Path, kind: &str, location_id: &str, errors: &mut Vec<String>) {
    if !candidate_exists(path, kind) {
        if kind == "directory" {
            errors.push(format!("location_not_directory:{location_id}"));
        } else if kind == "database" {
            errors.push(format!("location_not_file:{location_id}"));
        }
    }
}

// 检查已存在来源目录的典型历史子项，缺失时追加警告。
fn validate_source_shape(spec: &SourceSpec, path: &Path, warnings: &mut Vec<String>) {
    if !candidate_exists(path, spec.location.kind) {
        return;
    }

    match spec.id {
        "claude" if !candidate_exists(&path.join("projects"), "directory") => {
            warnings.push("claude_projects_dir_not_found".to_string());
        }
        "codex"
            if !candidate_exists(&path.join("sessions"), "directory")
                && !candidate_exists(&path.join("history.jsonl"), "file") =>
        {
            warnings.push("codex_sessions_not_found".to_string());
        }
        "kimi"
            if !candidate_exists(&path.join("sessions"), "directory")
                && !candidate_exists(&path.join("session_index.jsonl"), "file") =>
        {
            warnings.push("kimi_sessions_not_found".to_string());
        }
        _ => {}
    }
}

// database 类型检查文件，其他类型检查目录；WSL 通过带五秒超时的 test 判断。
fn candidate_exists(path: &Path, kind: &str) -> bool {
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc_path(&path.to_string_lossy()) {
        let Some(executable) = crate::wsl::find_wsl_exe() else {
            return false;
        };
        let test = if kind == "database" { "-f" } else { "-d" };
        let mut command =
            crate::shell_resolver::silent_command(executable.to_string_lossy().as_ref());
        command.args(["-d", &distro, "--exec", "test", test, &linux_path]);
        return crate::shell_resolver::output_with_timeout(command, Duration::from_secs(5))
            .map(|output| output.status.success())
            .unwrap_or(false);
    }
    match kind {
        "database" => path.is_file(),
        _ => path.is_dir(),
    }
}

// 将路径转为损失容忍的拥有字符串。
fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// 按平台优先级从非空用户目录环境变量取得路径。
fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
            .map(PathBuf::from)
    }
}

// 按编译目标返回本机 Windows、macOS 或 Linux 环境标识。
fn current_environment() -> HistorySourceEnvironment {
    #[cfg(target_os = "windows")]
    {
        HistorySourceEnvironment::Windows
    }
    #[cfg(target_os = "macos")]
    {
        HistorySourceEnvironment::Macos
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        HistorySourceEnvironment::Linux
    }
}

// WSL UNC 路径返回发行版环境，否则使用本机平台标识。
fn environment_for_path(path: &Path) -> HistorySourceEnvironment {
    crate::wsl::parse_wsl_unc_path(&path.to_string_lossy())
        .map(|(distro, _)| HistorySourceEnvironment::Wsl { distro })
        .unwrap_or_else(current_environment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    // 验证来源注册表数量与 Kiro 位置类型保持约定。
    fn descriptors_keep_source_registry_size() {
        let descriptors = history_sources_list_descriptors();
        assert_eq!(descriptors.len(), 12);
        let kiro = descriptors
            .iter()
            .find(|descriptor| descriptor.id == "kiro")
            .unwrap();
        assert_eq!(kiro.locations[0].kind, "directory");
    }

    #[test]
    // 验证缺失必需 Claude 配置位置时返回校验错误。
    fn validate_rejects_missing_required_location() {
        let result = history_sources_validate(HistorySourceValidateRequest {
            source_id: "claude".to_string(),
            locations: BTreeMap::new(),
        })
        .unwrap();

        assert!(!result.valid);
        assert_eq!(result.errors, vec!["missing_required_location:configRoot"]);
    }

    #[test]
    // 验证 WSL UNC 路径提取正确发行版环境，无需启动 WSL。
    fn detects_wsl_candidate_environment_from_unc_path() {
        assert!(matches!(
            environment_for_path(Path::new(r"\\wsl.localhost\Ubuntu\home\tester\.claude")),
            HistorySourceEnvironment::Wsl { distro } if distro == "Ubuntu"
        ));
    }

    #[cfg(windows)]
    #[test]
    // 验证 Grok 描述声明删除、恢复及实时统计能力。
    fn grok_history_capabilities_include_delete_resume_and_realtime_stats() {
        let grok = SOURCES.iter().find(|spec| spec.id == "grok").unwrap();
        assert_eq!(grok.capabilities.delete, "supported");
        assert_eq!(grok.capabilities.realtime_stats, "supported");
        assert_eq!(grok.capabilities.resume, "supported");
    }

    #[cfg(windows)]
    #[test]
    // 验证 Grok 默认候选指向用户目录下的 sessions 子目录。
    fn grok_default_candidate_is_the_session_root() {
        let grok = SOURCES.iter().find(|spec| spec.id == "grok").unwrap();
        let candidate = default_candidate_path_from_home(grok, Path::new(r"C:\Users\tester"));
        assert_eq!(candidate, PathBuf::from(r"C:\Users\tester\.grok\sessions"));
    }

    #[test]
    // 验证 Kimi 默认配置根及删除、恢复和实时统计能力。
    fn kimi_default_candidate_is_the_config_root() {
        let kimi = SOURCES.iter().find(|spec| spec.id == "kimi").unwrap();
        let candidate = default_candidate_path_from_home(kimi, Path::new(r"C:\Users\tester"));
        assert_eq!(
            candidate,
            PathBuf::from(r"C:\Users\tester").join(".kimi-code")
        );
        assert_eq!(kimi.capabilities.delete, "supported");
        assert_eq!(kimi.capabilities.realtime_stats, "supported");
        assert_eq!(kimi.capabilities.resume, "supported");
    }
}
