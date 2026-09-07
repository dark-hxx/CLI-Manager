use crate::installer::{read_installation_record, InstallationRecord};
use crate::layout::{resolve_layout, AgentLayout};
use cli_manager_hook_schema::{
    kimi::{self, KimiPlanAction, ALL_MODULES as ALL_KIMI_HOOK_MODULES},
    HookConfigChange, HookConfigFile, HookConfigReport, HookConfigRequest,
    HookHistorySourceCandidate, HookInstallationFile, HookInstallationRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use toml_edit::{value, DocumentMut, Item};
use uuid::Uuid;

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MISSING_FINGERPRINT: &str = "missing";
const ADAPTER_VERSION: u16 = 1;
const CLAUDE_QUESTION_TOOL_NAME: &str = "AskUserQuestion";
const CODEX_QUESTION_TOOL_NAME: &str = "request_user_input";

const CLAUDE_HOOKS: &[(&str, &str, &str)] = &[
    ("SessionStart", "SessionStart", ""),
    ("UserPromptSubmit", "UserPromptSubmit", ""),
    (
        "Notification",
        "Notification",
        "permission_prompt|idle_prompt",
    ),
    ("PreToolUse", "Notification", CLAUDE_QUESTION_TOOL_NAME),
    ("Stop", "Stop", ""),
    ("StopFailure", "StopFailure", ""),
    ("SubagentStart", "SubagentStart", ""),
    ("SubagentStop", "SubagentStop", ""),
    ("PreToolUse", "AgentToolStart", "Agent|Task"),
    ("PostToolUse", "AgentToolStop", "Agent|Task"),
    ("PreToolUse", "ToolStart", ""),
    ("PostToolUse", "ToolStop", ""),
];

const CODEX_HOOKS: &[(&str, &str, &str)] = &[
    ("SessionStart", "SessionStart", ""),
    ("UserPromptSubmit", "UserPromptSubmit", ""),
    ("PermissionRequest", "PermissionRequest", ""),
    ("PreToolUse", "Notification", CODEX_QUESTION_TOOL_NAME),
    ("Stop", "Stop", ""),
    ("SubagentStart", "SubagentStart", ""),
    ("SubagentStop", "SubagentStop", ""),
];

const GROK_HOOKS: &[(&str, &str, &str)] = &[
    ("SessionStart", "SessionStart", ""),
    ("UserPromptSubmit", "UserPromptSubmit", ""),
    (
        "PreToolUse",
        "PermissionRequest",
        "Bash|Edit|Write|MultiEdit",
    ),
    ("Stop", "Stop", ""),
    ("StopFailure", "StopFailure", ""),
    ("SubagentStart", "SubagentStart", ""),
    ("SubagentStop", "SubagentStop", ""),
    ("PreToolUse", "AgentToolStart", "Agent|Task"),
    ("PostToolUse", "AgentToolStop", "Agent|Task"),
    ("PreToolUse", "ToolStart", ""),
    ("PostToolUse", "ToolStop", ""),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Claude,
    Codex,
    Kimi,
    Grok,
}

impl Source {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "kimi" => Ok(Self::Kimi),
            "grok" => Ok(Self::Grok),
            _ => Err("hook_source_invalid".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Kimi => "kimi",
            Self::Grok => "grok",
        }
    }

    fn default_dir(self) -> &'static str {
        match self {
            Self::Claude => ".claude",
            Self::Codex => ".codex",
            Self::Kimi => ".kimi-code",
            Self::Grok => ".grok",
        }
    }

    fn hooks(self) -> &'static [(&'static str, &'static str, &'static str)] {
        match self {
            Self::Claude => CLAUDE_HOOKS,
            Self::Codex => CODEX_HOOKS,
            Self::Kimi => &[],
            Self::Grok => GROK_HOOKS,
        }
    }

    fn required_entries(self) -> u32 {
        match self {
            Self::Kimi => kimi::DEFINITIONS.len() as u32,
            _ => self.hooks().len() as u32,
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedRoot {
    configured: String,
    requested: PathBuf,
    canonical: PathBuf,
    hash: String,
    existed: bool,
}

#[derive(Debug, Clone)]
struct FileState {
    role: &'static str,
    logical_path: PathBuf,
    canonical_path: PathBuf,
    bytes: Vec<u8>,
    exists: bool,
    mode: Option<u32>,
}

impl FileState {
    fn fingerprint(&self) -> String {
        fingerprint(self.exists.then_some(self.bytes.as_slice()))
    }

    fn report(&self) -> HookConfigFile {
        HookConfigFile {
            role: self.role.to_string(),
            canonical_path: path_text(&self.canonical_path),
            fingerprint: self.fingerprint(),
            exists: self.exists,
        }
    }
}

#[derive(Debug, Clone)]
struct PlannedFile {
    before: FileState,
    after: Vec<u8>,
    after_exists: bool,
}

impl PlannedFile {
    fn after_fingerprint(&self) -> String {
        fingerprint(self.after_exists.then_some(self.after.as_slice()))
    }

    fn change(&self) -> HookConfigChange {
        let before = self.before.fingerprint();
        let after = self.after_fingerprint();
        HookConfigChange {
            role: self.before.role.to_string(),
            canonical_path: path_text(&self.before.canonical_path),
            before_fingerprint: before.clone(),
            after_fingerprint: after.clone(),
            action: if before == after {
                "unchanged".to_string()
            } else if !self.after_exists {
                "delete".to_string()
            } else if self.before.exists {
                "update".to_string()
            } else {
                "create".to_string()
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransactionFile {
    role: String,
    canonical_path: String,
    existed: bool,
    before_fingerprint: String,
    after_fingerprint: String,
    mode: Option<u32>,
    backup_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransactionJournal {
    files: Vec<TransactionFile>,
}

struct HookLock(PathBuf);

impl Drop for HookLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn validate_canonical_path(path: &Path) -> Result<(), String> {
    let text = path
        .to_str()
        .ok_or_else(|| "hook_config_canonical_path_invalid".to_string())?;
    if !path.is_absolute() || text.contains(['\0', '\r', '\n', '\\']) {
        return Err("hook_config_canonical_path_invalid".to_string());
    }
    Ok(())
}

fn fingerprint(bytes: Option<&[u8]>) -> String {
    let Some(bytes) = bytes else {
        return MISSING_FINGERPRINT.to_string();
    };
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn config_root_hash(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_os_str().as_encoded_bytes());
    format!("{:x}", hasher.finalize())
}

fn ensure_current_user_owner(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::metadata(path).map_err(|_| "hook_config_metadata_failed".to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("hook_config_owner_mismatch".to_string());
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn valid_fingerprint(value: &str) -> bool {
    value == MISSING_FINGERPRINT
        || (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn validate_configured_root(value: &str) -> Result<(), String> {
    if value.contains(['\0', '\r', '\n', '\\', '$', '`']) {
        return Err("hook_config_root_invalid".to_string());
    }
    let path = Path::new(value);
    if value.is_empty() {
        return Ok(());
    }
    if value != "~" && !value.starts_with("~/") && !path.is_absolute() {
        return Err("hook_config_root_invalid".to_string());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("hook_config_root_parent_forbidden".to_string());
    }
    Ok(())
}

fn expand_root(value: &str, source: Source, layout: &AgentLayout) -> PathBuf {
    if value.is_empty() {
        return layout.home.join(source.default_dir());
    }
    if value == "~" {
        return layout.home.clone();
    }
    value
        .strip_prefix("~/")
        .map(|suffix| layout.home.join(suffix))
        .unwrap_or_else(|| PathBuf::from(value))
}

fn resolve_root(
    configured: &str,
    source: Source,
    layout: &AgentLayout,
    create_default: bool,
) -> Result<ResolvedRoot, String> {
    let configured = configured.trim();
    validate_configured_root(configured)?;
    let requested = expand_root(configured, source, layout);
    let is_default = configured.is_empty();
    let missing = !requested.exists();
    if missing && !is_default {
        return Err("hook_config_root_missing".to_string());
    }
    if missing && create_default {
        fs::create_dir_all(&requested).map_err(|_| "hook_config_root_create_failed".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&requested, fs::Permissions::from_mode(0o700))
                .map_err(|_| "hook_config_root_permissions_failed".to_string())?;
        }
    }
    let canonical = if requested.exists() {
        if !requested.is_dir() {
            return Err("hook_config_root_not_directory".to_string());
        }
        fs::canonicalize(&requested)
            .map_err(|_| "hook_config_root_canonicalize_failed".to_string())?
    } else {
        fs::canonicalize(&layout.home)
            .map_err(|_| "home_directory_unavailable".to_string())?
            .join(source.default_dir())
    };
    if canonical.exists() {
        ensure_current_user_owner(&canonical)?;
    }
    validate_canonical_path(&canonical)?;
    let hash = config_root_hash(&canonical);
    Ok(ResolvedRoot {
        configured: configured.to_string(),
        requested,
        canonical,
        hash,
        existed: !missing,
    })
}

fn resolve_recorded_uninstall_root(
    configured: &str,
    expected_canonical_root: Option<&str>,
    source: Source,
    layout: &AgentLayout,
) -> Result<ResolvedRoot, String> {
    if let Some(expected) = expected_canonical_root {
        let path = Path::new(expected);
        validate_canonical_path(path)?;
        if expected.trim() != expected
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err("hook_config_canonical_path_invalid".to_string());
        }
    }
    let directory = hook_state_dir(layout).join("installations");
    let mut matches = Vec::new();
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("hook_config_root_missing".to_string());
        }
        Err(_) => return Err("hook_config_record_read_failed".to_string()),
    };
    for (index, entry) in entries.enumerate() {
        if index >= 256 {
            return Err("hook_config_record_limit".to_string());
        }
        let path = entry
            .map_err(|_| "hook_config_record_read_failed".to_string())?
            .path();
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&format!("{}-", source.as_str())))
        {
            continue;
        }
        let metadata =
            fs::metadata(&path).map_err(|_| "hook_config_record_read_failed".to_string())?;
        if !metadata.is_file() || metadata.len() > 64 * 1024 {
            return Err("hook_config_record_invalid".to_string());
        }
        let record: HookInstallationRecord = serde_json::from_slice(
            &fs::read(path).map_err(|_| "hook_config_record_read_failed".to_string())?,
        )
        .map_err(|_| "hook_config_record_invalid".to_string())?;
        if record.source != source.as_str()
            || record.configured_config_root != configured
            || expected_canonical_root
                .is_some_and(|expected| record.canonical_config_root != expected)
        {
            continue;
        }
        let canonical = PathBuf::from(&record.canonical_config_root);
        validate_canonical_path(&canonical)?;
        let record_hash = match (source, record.history_source_candidate.as_ref()) {
            (Source::Kimi | Source::Grok, None) => config_root_hash(&canonical),
            (Source::Claude | Source::Codex, Some(candidate))
                if candidate.source == source.as_str()
                    && candidate.canonical_config_root == record.canonical_config_root
                    && candidate.config_root_hash == config_root_hash(&canonical) =>
            {
                candidate.config_root_hash.clone()
            }
            _ => return Err("hook_config_record_invalid".to_string()),
        };
        let existed = canonical.exists();
        if existed {
            if !canonical.is_dir() {
                return Err("hook_config_record_invalid".to_string());
            }
            if fs::canonicalize(&canonical)
                .map_err(|_| "hook_config_root_canonicalize_failed".to_string())?
                != canonical
            {
                return Err("hook_config_root_changed".to_string());
            }
            ensure_current_user_owner(&canonical)?;
        }
        matches.push(ResolvedRoot {
            configured: configured.to_string(),
            requested: canonical.clone(),
            hash: record_hash,
            canonical,
            existed,
        });
    }
    match matches.len() {
        0 if expected_canonical_root.is_some() => Err("hook_config_root_changed".to_string()),
        0 => Err("hook_config_root_missing".to_string()),
        1 => Ok(matches.pop().expect("one matching Hook record")),
        _ => Err("hook_config_record_conflict".to_string()),
    }
}

fn resolve_uninstall_root(
    configured: &str,
    expected_canonical_root: Option<&str>,
    source: Source,
    layout: &AgentLayout,
) -> Result<ResolvedRoot, String> {
    let configured = configured.trim();
    match resolve_root(configured, source, layout, false) {
        Ok(root)
            if expected_canonical_root
                .is_some_and(|expected| path_text(&root.canonical) != expected) =>
        {
            resolve_recorded_uninstall_root(configured, expected_canonical_root, source, layout)
        }
        Err(error) if error == "hook_config_root_missing" => {
            resolve_recorded_uninstall_root(configured, expected_canonical_root, source, layout)
        }
        result => result,
    }
}

fn root_target_unchanged(root: &ResolvedRoot) -> Result<(), String> {
    match fs::symlink_metadata(&root.requested) {
        Ok(_) => {
            let current = fs::canonicalize(&root.requested)
                .map_err(|_| "hook_config_root_changed".to_string())?;
            if current != root.canonical {
                return Err("hook_config_root_changed".to_string());
            }
            Ok(())
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && !root.existed
                && !root.canonical.exists() =>
        {
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("hook_config_root_changed".to_string())
        }
        Err(_) => Err("hook_config_metadata_failed".to_string()),
    }
}

fn resolve_config_file(
    root: &ResolvedRoot,
    role: &'static str,
    name: &str,
) -> Result<FileState, String> {
    root_target_unchanged(root)?;
    let logical = root.requested.join(name);
    let canonical_path = match fs::symlink_metadata(&logical) {
        Ok(_) => {
            fs::canonicalize(&logical).map_err(|_| "hook_config_symlink_invalid".to_string())?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && root.requested.exists() => {
            fs::canonicalize(&root.requested)
                .map_err(|_| "hook_config_root_canonicalize_failed".to_string())?
                .join(name)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => root.canonical.join(name),
        Err(_) => return Err("hook_config_metadata_failed".to_string()),
    };
    root_target_unchanged(root)?;
    if canonical_path.exists() && !canonical_path.is_file() {
        return Err("hook_config_not_file".to_string());
    }
    validate_canonical_path(&canonical_path)?;
    let exists = canonical_path.exists();
    if exists {
        ensure_current_user_owner(&canonical_path)?;
    }
    let bytes = if exists {
        let metadata =
            fs::metadata(&canonical_path).map_err(|_| "hook_config_metadata_failed".to_string())?;
        if metadata.len() > MAX_CONFIG_BYTES {
            return Err("hook_config_too_large".to_string());
        }
        fs::read(&canonical_path).map_err(|_| "hook_config_read_failed".to_string())?
    } else {
        Vec::new()
    };
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        exists
            .then(|| {
                fs::metadata(&canonical_path)
                    .ok()
                    .map(|value| value.permissions().mode())
            })
            .flatten()
    };
    #[cfg(not(unix))]
    let mode = None;
    Ok(FileState {
        role,
        logical_path: logical,
        canonical_path,
        bytes,
        exists,
        mode,
    })
}

fn installation(layout: &AgentLayout) -> Result<InstallationRecord, String> {
    let record = read_installation_record(layout)?
        .ok_or_else(|| "agent_installation_record_missing".to_string())?;
    validate_canonical_path(&record.install_path)?;
    Ok(record)
}

fn run_kimi_command(executable: &Path, args: &[&str]) -> Result<bool, String> {
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "hook_config_doctor_failed".to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("hook_config_doctor_failed".to_string());
            }
            Err(_) => return Err("hook_config_doctor_failed".to_string()),
        }
    }
}

fn discover_kimi_executable(layout: &AgentLayout) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|path| path.join("kimi")));
    }
    candidates.push(layout.home.join(".kimi-code/bin/kimi"));
    for candidate in candidates {
        if supports_current_kimi(&candidate) {
            return Ok(candidate);
        }
    }
    Err("kimi_code_unsupported".to_string())
}

fn supports_current_kimi(executable: &Path) -> bool {
    executable.is_file() && run_kimi_command(executable, &["doctor", "--help"]).unwrap_or(false)
}

fn ensure_kimi_capability(source: Source, layout: &AgentLayout) -> Result<Option<PathBuf>, String> {
    if source == Source::Kimi {
        discover_kimi_executable(layout).map(Some)
    } else {
        Ok(None)
    }
}

fn validate_kimi_candidate(
    executable: &Path,
    config_path: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    let parent = config_path
        .parent()
        .ok_or_else(|| "hook_config_path_invalid".to_string())?;
    let candidate = parent.join(format!(
        ".config.toml.cli-manager-{}.tmp",
        Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file =
            File::create(&candidate).map_err(|_| "kimi_candidate_write_failed".to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "kimi_candidate_write_failed".to_string())?;
        set_mode(&candidate, Some(0o600))?;
        let candidate_text = candidate
            .to_str()
            .ok_or_else(|| "kimi_candidate_path_invalid".to_string())?;
        if run_kimi_command(executable, &["doctor", "config", candidate_text])? {
            Ok(())
        } else {
            Err("hook_config_doctor_failed".to_string())
        }
    })();
    let _ = fs::remove_file(candidate);
    result
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn hook_command(installation: &InstallationRecord, source: Source, event: &str) -> String {
    let owner = (source == Source::Kimi).then(|| {
        format!(
            " --owner {}{}",
            kimi::SSH_OWNER_PREFIX,
            installation.installation_id
        )
    });
    format!(
        "{} hook --source {} --event {}{} --managed-by cli-manager-ssh-agent --installation-id {}",
        posix_quote(&path_text(&installation.install_path)),
        source.as_str(),
        event,
        owner.as_deref().unwrap_or_default(),
        installation.installation_id
    )
}

fn kimi_commands(installation: &InstallationRecord) -> BTreeMap<String, String> {
    kimi::DEFINITIONS
        .iter()
        .map(|definition| {
            (
                definition.bridge_event.to_string(),
                hook_command(installation, Source::Kimi, definition.bridge_event),
            )
        })
        .collect()
}

fn read_json(state: &FileState) -> Result<Value, String> {
    if state.bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    let value: Value =
        serde_json::from_slice(&state.bytes).map_err(|_| "hook_config_json_invalid".to_string())?;
    if !value.is_object() {
        return Err("hook_config_json_root_invalid".to_string());
    }
    Ok(value)
}

fn command_values(value: &Value) -> impl Iterator<Item = &str> {
    value
        .get("hooks")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|events| events.values())
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|entry| entry.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter_map(|hook| hook.get("command").and_then(Value::as_str))
}

fn exact_commands(
    installation: &InstallationRecord,
    source: Source,
) -> HashMap<&'static str, String> {
    source
        .hooks()
        .iter()
        .map(|(_, command_event, _)| {
            (
                *command_event,
                hook_command(installation, source, command_event),
            )
        })
        .collect()
}

fn inspect_json(
    value: &Value,
    source: Source,
    expected: &HashMap<&str, String>,
) -> Result<(u32, bool, bool), String> {
    if let Some(hooks) = value.get("hooks") {
        if !hooks.is_object() {
            return Err("hook_config_hooks_invalid".to_string());
        }
        let relevant_events: HashSet<&str> = source
            .hooks()
            .iter()
            .map(|(hook_event, _, _)| *hook_event)
            .collect();
        for event in hooks
            .as_object()
            .into_iter()
            .flat_map(|map| relevant_events.iter().filter_map(|name| map.get(*name)))
        {
            let Some(entries) = event.as_array() else {
                return Err("hook_config_event_invalid".to_string());
            };
            for entry in entries {
                let Some(commands) = entry.get("hooks").and_then(Value::as_array) else {
                    return Err("hook_config_event_invalid".to_string());
                };
                if commands.iter().any(|command| !command.is_object()) {
                    return Err("hook_config_event_invalid".to_string());
                }
            }
        }
    }
    let mut managed = 0;
    let mut conflict = false;
    let mut outdated = false;
    for (hook_event, command_event, matcher) in source.hooks() {
        let expected_command = expected
            .get(command_event)
            .ok_or_else(|| "hook_config_command_missing".to_string())?;
        let mut occurrences = 0;
        if let Some(entries) = value
            .get("hooks")
            .and_then(|hooks| hooks.get(*hook_event))
            .and_then(Value::as_array)
        {
            for entry in entries {
                let entry_matcher = entry.get("matcher").and_then(Value::as_str).unwrap_or("");
                for hook in entry
                    .get("hooks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if hook.get("command").and_then(Value::as_str)
                        == Some(expected_command.as_str())
                    {
                        if entry_matcher == *matcher {
                            occurrences += 1;
                        } else {
                            conflict = true;
                        }
                    }
                }
            }
        }
        if occurrences >= 1 {
            managed += 1;
            outdated |= occurrences > 1;
        }
    }
    let expected_values: HashSet<&str> = expected.values().map(String::as_str).collect();
    for command in command_values(value) {
        if command.contains("--managed-by cli-manager-ssh-agent")
            && !expected_values.contains(command)
        {
            conflict = true;
        }
    }
    Ok((managed, conflict, outdated))
}

fn hooks_object(value: &mut Value) -> Result<&mut Map<String, Value>, String> {
    let root = value
        .as_object_mut()
        .ok_or_else(|| "hook_config_json_root_invalid".to_string())?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    hooks
        .as_object_mut()
        .ok_or_else(|| "hook_config_hooks_invalid".to_string())
}

fn add_exact_hooks(
    value: &mut Value,
    source: Source,
    expected: &HashMap<&str, String>,
) -> Result<(), String> {
    let hooks = hooks_object(value)?;
    for (hook_event, command_event, matcher) in source.hooks() {
        let command = expected
            .get(command_event)
            .ok_or_else(|| "hook_config_command_missing".to_string())?;
        let event = hooks
            .entry((*hook_event).to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let entries = event
            .as_array_mut()
            .ok_or_else(|| "hook_config_event_invalid".to_string())?;
        let mut already_present = false;
        entries.retain_mut(|entry| {
            if entry.get("matcher").and_then(Value::as_str).unwrap_or("") != *matcher {
                return true;
            }
            let Some(items) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            items.retain(|item| {
                if item.get("command").and_then(Value::as_str) != Some(command.as_str()) {
                    return true;
                }
                if already_present {
                    false
                } else {
                    already_present = true;
                    true
                }
            });
            !items.is_empty()
        });
        if !already_present {
            entries.push(json!({
                "matcher": matcher,
                "hooks": [{ "type": "command", "command": command, "timeout": 15 }]
            }));
        }
    }
    Ok(())
}

fn remove_exact_hooks(
    value: &mut Value,
    source: Source,
    expected: &HashMap<&str, String>,
) -> Result<(), String> {
    let Some(hooks) = value.get_mut("hooks") else {
        return Ok(());
    };
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| "hook_config_hooks_invalid".to_string())?;
    let mut empty_events = Vec::new();
    for (event_name, command_event, matcher) in source.hooks() {
        let Some(event) = hooks.get_mut(*event_name) else {
            continue;
        };
        let entries = event
            .as_array_mut()
            .ok_or_else(|| "hook_config_event_invalid".to_string())?;
        entries.retain_mut(|entry| {
            let entry_matcher = entry.get("matcher").and_then(Value::as_str).unwrap_or("");
            if entry_matcher != *matcher {
                return true;
            }
            let Some(commands) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let expected_command = expected.get(command_event).map(String::as_str);
            commands.retain(|item| item.get("command").and_then(Value::as_str) != expected_command);
            !commands.is_empty()
        });
        if entries.is_empty() {
            empty_events.push((*event_name).to_string());
        }
    }
    for event in empty_events {
        hooks.remove(&event);
    }
    if hooks.is_empty() {
        value
            .as_object_mut()
            .expect("JSON root validated")
            .remove("hooks");
    }
    Ok(())
}

fn serialize_json(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| "hook_config_json_serialize_failed".to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn feature_marker(installation_id: &str, previous: &str, table_created: bool) -> String {
    format!(
        " # cli-manager-ssh-agent installation={} previous={} tableCreated={}",
        installation_id, previous, table_created
    )
}

fn marker_suffix(item: &Item) -> String {
    item.as_value()
        .and_then(|value| value.decor().suffix())
        .and_then(|suffix| suffix.as_str())
        .map(str::to_string)
        .unwrap_or_default()
}

fn parse_owned_marker(suffix: &str, installation_id: &str) -> Option<(String, bool, String)> {
    let marker = "# cli-manager-ssh-agent ";
    let (original_suffix, fields) = suffix.rsplit_once(marker)?;
    let mut installation = None;
    let mut previous = None;
    let mut table_created = None;
    for field in fields.split_whitespace() {
        let (key, value) = field.split_once('=')?;
        match key {
            "installation" => installation = Some(value),
            "previous" => previous = Some(value),
            "tableCreated" => table_created = Some(value == "true"),
            _ => {}
        }
    }
    (installation == Some(installation_id)).then(|| {
        (
            previous.unwrap_or("missing").to_string(),
            table_created.unwrap_or(false),
            original_suffix.to_string(),
        )
    })
}

fn item_decor(item: &Item) -> (String, String) {
    let Some(value) = item.as_value() else {
        return (String::new(), String::new());
    };
    let prefix = value
        .decor()
        .prefix()
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let suffix = value
        .decor()
        .suffix()
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    (prefix, suffix)
}

fn parse_toml(state: &FileState) -> Result<DocumentMut, String> {
    let text = std::str::from_utf8(&state.bytes)
        .map_err(|_| "hook_config_toml_utf8_invalid".to_string())?;
    DocumentMut::from_str(text).map_err(|_| "hook_config_toml_invalid".to_string())
}

fn codex_feature_enabled(document: &DocumentMut) -> bool {
    document
        .get("features")
        .and_then(Item::as_table_like)
        .and_then(|features| features.get("hooks"))
        .and_then(Item::as_bool)
        == Some(true)
}

fn install_codex_feature(document: &mut DocumentMut, installation_id: &str) -> Result<(), String> {
    if codex_feature_enabled(document) {
        return Ok(());
    }
    let table_created = !document.contains_key("features");
    if table_created {
        document["features"] = Item::Table(toml_edit::Table::new());
    }
    let features = document["features"]
        .as_table_like_mut()
        .ok_or_else(|| "hook_config_toml_features_invalid".to_string())?;
    let (previous, prefix, suffix) = match features.get("hooks") {
        None => ("missing", String::new(), String::new()),
        Some(item) if item.as_bool() == Some(false) => {
            let (prefix, suffix) = item_decor(item);
            ("false", prefix, suffix)
        }
        Some(_) => return Err("hook_config_toml_hooks_invalid".to_string()),
    };
    let mut owned = value(true);
    let decor = owned.as_value_mut().expect("toml bool value").decor_mut();
    decor.set_prefix(prefix);
    decor.set_suffix(format!(
        "{suffix}{}",
        feature_marker(installation_id, previous, table_created)
    ));
    features.insert("hooks", owned);
    Ok(())
}

fn uninstall_codex_feature(
    document: &mut DocumentMut,
    installation_id: &str,
) -> Result<(), String> {
    let Some(features) = document
        .get_mut("features")
        .and_then(Item::as_table_like_mut)
    else {
        return Ok(());
    };
    let Some(item) = features.get("hooks") else {
        return Ok(());
    };
    if item.as_bool() != Some(true) {
        return Ok(());
    }
    let prefix = item_decor(item).0;
    let Some((previous, table_created, original_suffix)) =
        parse_owned_marker(&marker_suffix(item), installation_id)
    else {
        return Ok(());
    };
    match previous.as_str() {
        "false" => {
            let mut restored = value(false);
            let decor = restored
                .as_value_mut()
                .expect("toml bool value")
                .decor_mut();
            decor.set_prefix(prefix);
            decor.set_suffix(original_suffix);
            features.insert("hooks", restored);
        }
        "missing" => {
            features.remove("hooks");
        }
        _ => return Err("hook_config_toml_marker_invalid".to_string()),
    }
    if table_created && features.is_empty() {
        document.remove("features");
    }
    Ok(())
}

fn grok_compat_marker(
    installation_id: &str,
    previous: &str,
    compat_created: bool,
    vendor_created: bool,
) -> String {
    format!(
        " # cli-manager-ssh-agent installation={installation_id} previous={previous} compatCreated={compat_created} vendorCreated={vendor_created}"
    )
}

fn parse_grok_compat_marker(
    suffix: &str,
    installation_id: &str,
) -> Option<(String, bool, bool, String)> {
    let marker = "# cli-manager-ssh-agent ";
    let (original_suffix, fields) = suffix.rsplit_once(marker)?;
    let mut installation = None;
    let mut previous = None;
    let mut compat_created = None;
    let mut vendor_created = None;
    for field in fields.split_whitespace() {
        let (key, value) = field.split_once('=')?;
        match key {
            "installation" => installation = Some(value),
            "previous" => previous = Some(value),
            "compatCreated" => {
                compat_created = match value {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => return None,
                }
            }
            "vendorCreated" => {
                vendor_created = match value {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => return None,
                }
            }
            _ => {}
        }
    }
    if installation != Some(installation_id) {
        return None;
    }
    Some((
        previous?.to_string(),
        compat_created?,
        vendor_created?,
        original_suffix.to_string(),
    ))
}

fn install_grok_compat_hooks(
    document: &mut DocumentMut,
    installation_id: &str,
    vendor: &str,
) -> Result<(), String> {
    let compat_created = !document.contains_key("compat");
    if compat_created {
        document["compat"] = Item::Table(toml_edit::Table::new());
    }
    let compat = document["compat"]
        .as_table_like_mut()
        .ok_or_else(|| "hook_config_toml_compat_invalid".to_string())?;
    let vendor_created = !compat.contains_key(vendor);
    if vendor_created {
        compat.insert(vendor, Item::Table(toml_edit::Table::new()));
    }
    let vendor_config = compat
        .get_mut(vendor)
        .and_then(Item::as_table_like_mut)
        .ok_or_else(|| "hook_config_toml_compat_vendor_invalid".to_string())?;
    let (previous, prefix, suffix) = match vendor_config.get("hooks") {
        None => ("missing", String::new(), String::new()),
        Some(item) if item.as_bool() == Some(true) => {
            let (prefix, suffix) = item_decor(item);
            ("true", prefix, suffix)
        }
        Some(item) if item.as_bool() == Some(false) => return Ok(()),
        Some(_) => return Err("hook_config_toml_compat_hooks_invalid".to_string()),
    };
    let mut owned = value(false);
    let decor = owned.as_value_mut().expect("toml bool value").decor_mut();
    decor.set_prefix(prefix);
    decor.set_suffix(format!(
        "{suffix}{}",
        grok_compat_marker(installation_id, previous, compat_created, vendor_created)
    ));
    vendor_config.insert("hooks", owned);
    Ok(())
}

fn install_grok_compat_isolation(
    document: &mut DocumentMut,
    installation_id: &str,
) -> Result<(), String> {
    for vendor in ["claude", "cursor"] {
        install_grok_compat_hooks(document, installation_id, vendor)?;
    }
    Ok(())
}

fn uninstall_grok_compat_hooks(
    document: &mut DocumentMut,
    installation_id: &str,
    vendor: &str,
) -> Result<bool, String> {
    let Some(compat) = document.get_mut("compat").and_then(Item::as_table_like_mut) else {
        return Ok(false);
    };
    let Some(vendor_config) = compat.get_mut(vendor).and_then(Item::as_table_like_mut) else {
        return Ok(false);
    };
    let Some(item) = vendor_config.get("hooks") else {
        return Ok(false);
    };
    if item.as_bool() != Some(false) {
        return Ok(false);
    }
    let prefix = item_decor(item).0;
    let Some((previous, compat_created, vendor_created, original_suffix)) =
        parse_grok_compat_marker(&marker_suffix(item), installation_id)
    else {
        return Ok(false);
    };
    match previous.as_str() {
        "true" => {
            let mut restored = value(true);
            let decor = restored
                .as_value_mut()
                .expect("toml bool value")
                .decor_mut();
            decor.set_prefix(prefix);
            decor.set_suffix(original_suffix);
            vendor_config.insert("hooks", restored);
        }
        "missing" => {
            vendor_config.remove("hooks");
        }
        _ => return Err("hook_config_toml_marker_invalid".to_string()),
    }
    let remove_vendor = vendor_created && vendor_config.is_empty();
    if remove_vendor {
        compat.remove(vendor);
    }
    Ok(compat_created)
}

fn uninstall_grok_compat_isolation(
    document: &mut DocumentMut,
    installation_id: &str,
) -> Result<(), String> {
    let mut compat_created = false;
    for vendor in ["claude", "cursor"] {
        compat_created |= uninstall_grok_compat_hooks(document, installation_id, vendor)?;
    }
    if compat_created
        && document
            .get("compat")
            .and_then(Item::as_table_like)
            .is_some_and(|compat| compat.is_empty())
    {
        document.remove("compat");
    }
    Ok(())
}

fn grok_compat_hooks_disabled(document: &DocumentMut, vendor: &str) -> bool {
    let nested = document
        .get("compat")
        .and_then(Item::as_table_like)
        .and_then(|compat| compat.get(vendor))
        .and_then(Item::as_table_like)
        .and_then(|table| table.get("hooks"))
        .and_then(Item::as_bool);
    let dotted_table = document
        .get(&format!("compat.{vendor}"))
        .and_then(Item::as_table_like)
        .and_then(|table| table.get("hooks"))
        .and_then(Item::as_bool);
    let dotted_key = document
        .get("compat")
        .and_then(Item::as_table_like)
        .and_then(|compat| compat.get(&format!("{vendor}.hooks")))
        .and_then(Item::as_bool);
    nested.or(dotted_table).or(dotted_key) == Some(false)
}

fn grok_compat_isolated(document: &DocumentMut) -> bool {
    ["claude", "cursor"]
        .iter()
        .all(|vendor| grok_compat_hooks_disabled(document, vendor))
}

fn plan_files(
    root: &ResolvedRoot,
    source: Source,
    installation: &InstallationRecord,
    operation: Option<bool>,
) -> Result<(Vec<PlannedFile>, u32, bool), String> {
    if source == Source::Kimi {
        let state = resolve_config_file(root, "kimiConfig", "config.toml")?;
        let original = std::str::from_utf8(&state.bytes)
            .map_err(|_| "hook_config_toml_utf8_invalid".to_string())?;
        let action = match operation {
            Some(true) => KimiPlanAction::Install,
            Some(false) => KimiPlanAction::Uninstall,
            None => KimiPlanAction::Inspect,
        };
        let plan = kimi::plan(
            original,
            &kimi_commands(installation),
            &ALL_KIMI_HOOK_MODULES,
            action,
        )?;
        let after_exists = state.exists || operation == Some(true);
        return Ok((
            vec![PlannedFile {
                before: state,
                after: if after_exists {
                    plan.content.into_bytes()
                } else {
                    Vec::new()
                },
                after_exists,
            }],
            plan.managed_entries,
            plan.conflict || plan.outdated,
        ));
    }
    if source == Source::Grok {
        let json_state = resolve_config_file(root, "grokHooks", "hooks/cli-manager.json")?;
        let mut json_value = read_json(&json_state)?;
        let original_json = json_value.clone();
        let expected = exact_commands(installation, source);
        let (managed_entries, conflict, outdated) = inspect_json(&json_value, source, &expected)?;
        match operation {
            Some(true) => {
                if conflict {
                    return Err("hook_config_owner_conflict".to_string());
                }
                add_exact_hooks(&mut json_value, source, &expected)?;
            }
            Some(false) => {
                if conflict {
                    return Err("hook_config_owner_conflict".to_string());
                }
                remove_exact_hooks(&mut json_value, source, &expected)?;
            }
            None => {}
        }
        let json_after_exists = json_state.exists || operation == Some(true);
        let json_after = if !json_after_exists {
            Vec::new()
        } else if json_state.exists && json_value == original_json {
            json_state.bytes.clone()
        } else {
            serialize_json(&json_value)?
        };
        let toml_state = resolve_config_file(root, "grokCompat", "config.toml")?;
        let mut document = parse_toml(&toml_state)?;
        let toml_after = match operation {
            Some(true) => {
                install_grok_compat_isolation(&mut document, &installation.installation_id)?;
                document.to_string().into_bytes()
            }
            Some(false) => {
                uninstall_grok_compat_isolation(&mut document, &installation.installation_id)?;
                document.to_string().into_bytes()
            }
            _ if toml_state.exists => toml_state.bytes.clone(),
            _ => Vec::new(),
        };
        let toml_after_exists = toml_state.exists || operation == Some(true);
        return Ok((
            vec![
                PlannedFile {
                    before: json_state,
                    after: json_after,
                    after_exists: json_after_exists,
                },
                PlannedFile {
                    before: toml_state,
                    after: toml_after,
                    after_exists: toml_after_exists,
                },
            ],
            managed_entries,
            conflict || outdated,
        ));
    }
    let json_state = resolve_config_file(
        root,
        if source == Source::Claude {
            "claudeSettings"
        } else {
            "codexHooks"
        },
        if source == Source::Claude {
            "settings.json"
        } else {
            "hooks.json"
        },
    )?;
    let mut json_value = read_json(&json_state)?;
    let original_json = json_value.clone();
    let expected = exact_commands(installation, source);
    let (managed_entries, conflict, outdated) = inspect_json(&json_value, source, &expected)?;
    match operation {
        Some(true) => {
            if conflict {
                return Err("hook_config_owner_conflict".to_string());
            }
            add_exact_hooks(&mut json_value, source, &expected)?;
        }
        Some(false) => {
            if conflict {
                return Err("hook_config_owner_conflict".to_string());
            }
            remove_exact_hooks(&mut json_value, source, &expected)?;
        }
        None => {}
    }
    let json_after_exists = json_state.exists || operation == Some(true);
    let json_after = if !json_after_exists {
        Vec::new()
    } else if json_state.exists && json_value == original_json {
        json_state.bytes.clone()
    } else {
        serialize_json(&json_value)?
    };
    let mut plans = vec![PlannedFile {
        before: json_state,
        after: json_after,
        after_exists: json_after_exists,
    }];
    if source == Source::Codex {
        let toml_state = resolve_config_file(root, "codexFeature", "config.toml")?;
        let mut document = parse_toml(&toml_state)?;
        match operation {
            Some(true) => install_codex_feature(&mut document, &installation.installation_id)?,
            Some(false) => uninstall_codex_feature(&mut document, &installation.installation_id)?,
            None => {}
        }
        let toml_after_exists = toml_state.exists || operation == Some(true);
        plans.push(PlannedFile {
            before: toml_state,
            after: if toml_after_exists {
                document.to_string().into_bytes()
            } else {
                Vec::new()
            },
            after_exists: toml_after_exists,
        });
    }
    Ok((plans, managed_entries, conflict || outdated))
}

fn current_status(
    plans: &[PlannedFile],
    source: Source,
    installation: &InstallationRecord,
) -> Result<(String, u32), String> {
    if source == Source::Kimi {
        let original = std::str::from_utf8(&plans[0].before.bytes)
            .map_err(|_| "hook_config_toml_utf8_invalid".to_string())?;
        let plan = kimi::plan(
            original,
            &kimi_commands(installation),
            &ALL_KIMI_HOOK_MODULES,
            KimiPlanAction::Inspect,
        )?;
        let status = if plan.conflict {
            "conflict"
        } else if plan.outdated {
            "outdated"
        } else if plan.managed_entries == 0 {
            "notInstalled"
        } else if plan.managed_entries == source.required_entries() {
            "installed"
        } else {
            "partialInstalled"
        };
        return Ok((status.to_string(), plan.managed_entries));
    }
    let json = read_json(&plans[0].before)?;
    let expected = exact_commands(installation, source);
    let (managed, conflict, outdated) = inspect_json(&json, source, &expected)?;
    if conflict {
        return Ok(("conflict".to_string(), managed));
    }
    let feature_ready = match source {
        Source::Codex => {
            let document = parse_toml(&plans[1].before)?;
            codex_feature_enabled(&document)
        }
        Source::Grok => {
            if plans.len() < 2 {
                false
            } else {
                grok_compat_isolated(&parse_toml(&plans[1].before)?)
            }
        }
        _ => true,
    };
    let required = source.required_entries();
    let status = if managed == 0 {
        "notInstalled"
    } else if outdated {
        "outdated"
    } else if managed == required && feature_ready {
        "installed"
    } else {
        "partialInstalled"
    };
    Ok((status.to_string(), managed))
}

fn expected_files_match(plans: &[PlannedFile], request: &HookConfigRequest) -> Result<(), String> {
    if request.expected_files.len() != plans.len() {
        return Err("hook_config_fingerprint_required".to_string());
    }
    let expected: HashMap<(&str, &str), &str> = request
        .expected_files
        .iter()
        .map(|file| {
            if !valid_fingerprint(&file.fingerprint) {
                return Err("hook_config_fingerprint_invalid".to_string());
            }
            Ok((
                (file.role.as_str(), file.canonical_path.as_str()),
                file.fingerprint.as_str(),
            ))
        })
        .collect::<Result<_, String>>()?;
    for plan in plans {
        let key = (plan.before.role, path_text(&plan.before.canonical_path));
        if expected.get(&(key.0, key.1.as_str())).copied()
            != Some(plan.before.fingerprint().as_str())
        {
            return Err("hook_config_changed".to_string());
        }
    }
    Ok(())
}

fn hook_state_dir(layout: &AgentLayout) -> PathBuf {
    layout.state_dir.join("hooks")
}

fn lock_is_stale(path: &Path) -> bool {
    #[cfg(unix)]
    if let Some(pid) = fs::read_to_string(path)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
    {
        if Path::new("/proc").is_dir() {
            return !Path::new("/proc").join(pid.to_string()).exists();
        }
    }
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > Duration::from_secs(300))
}

fn acquire_lock(layout: &AgentLayout, root_hash: &str) -> Result<HookLock, String> {
    let directory = hook_state_dir(layout);
    fs::create_dir_all(&directory).map_err(|_| "hook_config_state_create_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "hook_config_state_permissions_failed".to_string())?;
    }
    let path = directory.join(format!("{root_hash}.lock"));
    for _ in 0..12 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                return Ok(HookLock(path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(&path) {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err("hook_config_lock_failed".to_string()),
        }
    }
    Err("hook_config_locked".to_string())
}

fn read_current(path: &Path) -> Result<(bool, Vec<u8>), String> {
    if !path.exists() {
        return Ok((false, Vec::new()));
    }
    let metadata = fs::metadata(path).map_err(|_| "hook_config_metadata_failed".to_string())?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err("hook_config_too_large".to_string());
    }
    Ok((
        true,
        fs::read(path).map_err(|_| "hook_config_read_failed".to_string())?,
    ))
}

fn config_target_unchanged(state: &FileState) -> Result<(), String> {
    let current = match fs::symlink_metadata(&state.logical_path) {
        Ok(_) => fs::canonicalize(&state.logical_path)
            .map_err(|_| "hook_config_symlink_invalid".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = state
                .logical_path
                .parent()
                .ok_or_else(|| "hook_config_path_invalid".to_string())?;
            if !state.exists && !parent.exists() && !state.canonical_path.exists() {
                return Ok(());
            }
            let file_name = state
                .logical_path
                .file_name()
                .ok_or_else(|| "hook_config_path_invalid".to_string())?;
            fs::canonicalize(parent)
                .map_err(|_| "hook_config_root_changed".to_string())?
                .join(file_name)
        }
        Err(_) => return Err("hook_config_metadata_failed".to_string()),
    };
    if current != state.canonical_path {
        return Err("hook_config_root_changed".to_string());
    }
    Ok(())
}

fn set_mode(path: &Path, mode: Option<u32>) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|_| "hook_config_permissions_failed".to_string())?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

fn replace_file(path: &Path, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "hook_config_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "hook_config_parent_create_failed".to_string())?;
    let temporary = parent.join(format!(".cli-manager-hook-{}.tmp", Uuid::new_v4().simple()));
    let mut file = File::create(&temporary).map_err(|_| "hook_config_write_failed".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "hook_config_write_failed".to_string())?;
    set_mode(&temporary, mode.or(Some(0o600)))?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "hook_config_replace_failed".to_string())?;
    }
    fs::rename(&temporary, path).map_err(|_| "hook_config_replace_failed".to_string())
}

fn restore_file(path: &Path, existed: bool, bytes: &[u8], mode: Option<u32>) -> Result<(), String> {
    if existed {
        replace_file(path, bytes, mode)
    } else if path.exists() {
        fs::remove_file(path).map_err(|_| "hook_config_restore_failed".to_string())
    } else {
        Ok(())
    }
}

fn transaction_dir(layout: &AgentLayout, root_hash: &str) -> PathBuf {
    hook_state_dir(layout).join("transactions").join(root_hash)
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| "hook_config_state_serialize_failed".to_string())?;
    write_bytes_atomic(path, &bytes)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "hook_config_state_path_invalid".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "hook_config_state_create_failed".to_string())?;
    let temporary = parent.join(format!(".hook-state-{}.tmp", Uuid::new_v4().simple()));
    let mut file =
        File::create(&temporary).map_err(|_| "hook_config_state_write_failed".to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "hook_config_state_write_failed".to_string())?;
    set_mode(&temporary, Some(0o600))?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|_| "hook_config_state_promote_failed".to_string())?;
    }
    fs::rename(temporary, path).map_err(|_| "hook_config_state_promote_failed".to_string())
}

fn restore_hook_record(path: &Path, previous: Option<&[u8]>) -> Result<(), String> {
    if let Some(previous) = previous {
        write_bytes_atomic(path, previous)
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("hook_config_record_rollback_failed".to_string()),
        }
    }
}

fn recover_transaction(layout: &AgentLayout, root_hash: &str) -> Result<(), String> {
    let directory = transaction_dir(layout, root_hash);
    let journal_path = directory.join("journal.json");
    if !journal_path.exists() {
        return Ok(());
    }
    let journal: TransactionJournal = serde_json::from_slice(
        &fs::read(&journal_path).map_err(|_| "hook_config_journal_read_failed".to_string())?,
    )
    .map_err(|_| "hook_config_journal_invalid".to_string())?;
    let mut conflict = false;
    for file in journal.files.iter().rev() {
        let path = PathBuf::from(&file.canonical_path);
        if !path.is_absolute() {
            return Err("hook_config_journal_invalid".to_string());
        }
        let (exists, current) = read_current(&path)?;
        let current_fingerprint = fingerprint(exists.then_some(current.as_slice()));
        if current_fingerprint == file.before_fingerprint {
            continue;
        }
        if current_fingerprint != file.after_fingerprint {
            conflict = true;
            continue;
        }
        let backup = fs::read(directory.join(&file.backup_name))
            .map_err(|_| "hook_config_backup_read_failed".to_string())?;
        restore_file(&path, file.existed, &backup, file.mode)?;
    }
    if conflict {
        return Err("hook_config_recovery_conflict".to_string());
    }
    fs::remove_dir_all(directory).map_err(|_| "hook_config_journal_cleanup_failed".to_string())
}

fn transaction_error(layout: &AgentLayout, root_hash: &str, error: String) -> String {
    match recover_transaction(layout, root_hash) {
        Ok(()) => error,
        Err(recovery) => format!("{error}:{recovery}"),
    }
}

fn apply_transaction(
    layout: &AgentLayout,
    root_hash: &str,
    plans: &[PlannedFile],
) -> Result<(), String> {
    recover_transaction(layout, root_hash)?;
    for plan in plans {
        config_target_unchanged(&plan.before)?;
        let (current_exists, current_bytes) = read_current(&plan.before.canonical_path)?;
        if fingerprint(current_exists.then_some(current_bytes.as_slice()))
            != plan.before.fingerprint()
        {
            return Err("hook_config_changed".to_string());
        }
    }
    let directory = transaction_dir(layout, root_hash);
    fs::create_dir_all(&directory).map_err(|_| "hook_config_journal_create_failed".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "hook_config_state_permissions_failed".to_string())?;
    }
    let mut files = Vec::new();
    for (index, plan) in plans.iter().enumerate() {
        let backup_name = format!("{index}.before");
        fs::write(directory.join(&backup_name), &plan.before.bytes)
            .map_err(|_| "hook_config_backup_write_failed".to_string())?;
        set_mode(&directory.join(&backup_name), Some(0o600))?;
        files.push(TransactionFile {
            role: plan.before.role.to_string(),
            canonical_path: path_text(&plan.before.canonical_path),
            existed: plan.before.exists,
            before_fingerprint: plan.before.fingerprint(),
            after_fingerprint: plan.after_fingerprint(),
            mode: plan.before.mode,
            backup_name,
        });
    }
    write_json_atomic(
        &directory.join("journal.json"),
        &TransactionJournal { files },
    )?;
    for plan in plans {
        if plan.before.fingerprint() == plan.after_fingerprint() {
            continue;
        }
        if let Err(error) = config_target_unchanged(&plan.before) {
            return Err(transaction_error(layout, root_hash, error));
        }
        let (current_exists, current_bytes) = read_current(&plan.before.canonical_path)?;
        if fingerprint(current_exists.then_some(current_bytes.as_slice()))
            != plan.before.fingerprint()
        {
            return Err(transaction_error(
                layout,
                root_hash,
                "hook_config_changed".to_string(),
            ));
        }
        let result = if plan.after_exists {
            replace_file(&plan.before.canonical_path, &plan.after, plan.before.mode)
        } else if plan.before.canonical_path.exists() {
            fs::remove_file(&plan.before.canonical_path)
                .map_err(|_| "hook_config_delete_failed".to_string())
        } else {
            Ok(())
        };
        if let Err(error) = result {
            return Err(transaction_error(layout, root_hash, error));
        }
    }
    for plan in plans {
        if let Err(error) = config_target_unchanged(&plan.before) {
            return Err(transaction_error(layout, root_hash, error));
        }
        let (exists, bytes) = read_current(&plan.before.canonical_path)?;
        if exists != plan.after_exists
            || fingerprint(exists.then_some(bytes.as_slice())) != plan.after_fingerprint()
        {
            return Err(transaction_error(
                layout,
                root_hash,
                "hook_config_verify_failed".to_string(),
            ));
        }
    }
    fs::remove_dir_all(directory).map_err(|_| "hook_config_journal_cleanup_failed".to_string())
}

fn report(
    outcome: (&str, String),
    source: Source,
    root: &ResolvedRoot,
    installation: &InstallationRecord,
    plans: &[PlannedFile],
    managed_entries: u32,
    record: Option<HookInstallationRecord>,
) -> HookConfigReport {
    let (action, status) = outcome;
    let applied = matches!(action, "installed" | "uninstalled");
    HookConfigReport {
        action: action.to_string(),
        status,
        source: source.as_str().to_string(),
        installation_id: installation.installation_id.clone(),
        remote_machine_id: installation.remote_machine_id.clone(),
        configured_config_root: root.configured.clone(),
        canonical_config_root: path_text(&root.canonical),
        config_root_hash: root.hash.clone(),
        config_root_exists: action == "installed" || root.existed,
        will_create_config_root: action == "previewInstall" && !root.existed,
        config_files: plans
            .iter()
            .map(|plan| {
                if applied {
                    HookConfigFile {
                        role: plan.before.role.to_string(),
                        canonical_path: path_text(&plan.before.canonical_path),
                        fingerprint: plan.after_fingerprint(),
                        exists: plan.after_exists,
                    }
                } else {
                    plan.before.report()
                }
            })
            .collect(),
        managed_entries,
        required_entries: source.required_entries(),
        changes: plans.iter().map(PlannedFile::change).collect(),
        installation: record,
    }
}

fn installation_record(
    source: Source,
    root: &ResolvedRoot,
    installation: &InstallationRecord,
    plans: &[PlannedFile],
) -> HookInstallationRecord {
    HookInstallationRecord {
        source: source.as_str().to_string(),
        installation_id: installation.installation_id.clone(),
        owner_id: format!("cli-manager-ssh-agent:{}", installation.installation_id),
        configured_config_root: root.configured.clone(),
        canonical_config_root: path_text(&root.canonical),
        config_files: plans
            .iter()
            .map(|plan| HookInstallationFile {
                role: plan.before.role.to_string(),
                canonical_path: path_text(&plan.before.canonical_path),
                before_fingerprint: plan.before.fingerprint(),
                after_fingerprint: plan.after_fingerprint(),
            })
            .collect(),
        managed_entries: source.required_entries(),
        adapter_version: ADAPTER_VERSION,
        installed_at: now_ms(),
        history_source_candidate: matches!(source, Source::Claude | Source::Codex).then(|| {
            HookHistorySourceCandidate {
                source: source.as_str().to_string(),
                canonical_config_root: path_text(&root.canonical),
                config_root_hash: root.hash.clone(),
            }
        }),
    }
}

fn record_path(layout: &AgentLayout, source: Source, root_hash: &str) -> PathBuf {
    hook_state_dir(layout)
        .join("installations")
        .join(format!("{}-{root_hash}.json", source.as_str()))
}

pub fn inspect(request: HookConfigRequest) -> Result<HookConfigReport, String> {
    let source = Source::parse(&request.source)?;
    let layout = resolve_layout().map_err(str::to_string)?;
    ensure_kimi_capability(source, &layout)?;
    let installation = installation(&layout)?;
    let root = resolve_root(&request.configured_config_root, source, &layout, false)?;
    let (plans, _, _) = plan_files(&root, source, &installation, None)?;
    let (status, managed) = current_status(&plans, source, &installation)?;
    Ok(report(
        ("inspect", status),
        source,
        &root,
        &installation,
        &plans,
        managed,
        None,
    ))
}

pub fn preview(request: HookConfigRequest, install: bool) -> Result<HookConfigReport, String> {
    if install && request.expected_canonical_root.is_some() {
        return Err("hook_config_action_invalid".to_string());
    }
    let source = Source::parse(&request.source)?;
    let layout = resolve_layout().map_err(str::to_string)?;
    if install {
        ensure_kimi_capability(source, &layout)?;
    }
    let installation = installation(&layout)?;
    let root = if install {
        resolve_root(&request.configured_config_root, source, &layout, false)?
    } else {
        resolve_uninstall_root(
            &request.configured_config_root,
            request.expected_canonical_root.as_deref(),
            source,
            &layout,
        )?
    };
    let (plans, _, _) = plan_files(&root, source, &installation, Some(install))?;
    let (status, managed) = current_status(&plans, source, &installation)?;
    Ok(report(
        (
            if install {
                "previewInstall"
            } else {
                "previewUninstall"
            },
            status,
        ),
        source,
        &root,
        &installation,
        &plans,
        managed,
        None,
    ))
}

pub fn apply(request: HookConfigRequest, install: bool) -> Result<HookConfigReport, String> {
    if install && request.expected_canonical_root.is_some() {
        return Err("hook_config_action_invalid".to_string());
    }
    let source = Source::parse(&request.source)?;
    let layout = resolve_layout().map_err(str::to_string)?;
    let kimi_executable = if install {
        ensure_kimi_capability(source, &layout)?
    } else {
        None
    };
    let installation = installation(&layout)?;
    let root = if install {
        resolve_root(&request.configured_config_root, source, &layout, true)?
    } else {
        resolve_uninstall_root(
            &request.configured_config_root,
            request.expected_canonical_root.as_deref(),
            source,
            &layout,
        )?
    };
    let _lock = acquire_lock(&layout, &root.hash)?;
    recover_transaction(&layout, &root.hash)?;
    let (plans, _, _) = plan_files(&root, source, &installation, Some(install))?;
    expected_files_match(&plans, &request)?;
    if install {
        if let Some(executable) = kimi_executable.as_deref() {
            validate_kimi_candidate(executable, &plans[0].before.canonical_path, &plans[0].after)?;
        }
    }
    let record = install.then(|| installation_record(source, &root, &installation, &plans));
    let hook_record_path = record_path(&layout, source, &root.hash);
    let previous_record = fs::read(&hook_record_path).ok();
    if let Some(record) = &record {
        write_json_atomic(&hook_record_path, record)?;
    }
    if let Err(error) = apply_transaction(&layout, &root.hash, &plans) {
        if record.is_some() {
            if let Err(rollback) =
                restore_hook_record(&hook_record_path, previous_record.as_deref())
            {
                return Err(format!("{error}:{rollback}"));
            }
        }
        return Err(error);
    }
    if record.is_none() && hook_record_path.exists() {
        fs::remove_file(hook_record_path)
            .map_err(|_| "hook_config_record_remove_failed".to_string())?;
    }
    Ok(report(
        (
            if install { "installed" } else { "uninstalled" },
            if install { "installed" } else { "notInstalled" }.to_string(),
        ),
        source,
        &root,
        &installation,
        &plans,
        if install {
            source.required_entries()
        } else {
            0
        },
        record,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        add_exact_hooks, apply_transaction, feature_marker, fingerprint, grok_compat_isolated,
        hook_command, inspect_json, install_codex_feature, install_grok_compat_isolation,
        parse_owned_marker, parse_toml, recover_transaction, remove_exact_hooks, transaction_dir,
        uninstall_codex_feature, uninstall_grok_compat_isolation, FileState, PlannedFile, Source,
        TransactionFile, TransactionJournal,
    };
    #[cfg(unix)]
    use super::{
        config_target_unchanged, exact_commands, installation_record, plan_files,
        supports_current_kimi, validate_kimi_candidate, ResolvedRoot,
    };
    use crate::installer::InstallationRecord;
    use crate::layout::AgentLayout;
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;

    fn installation_record_for_test(path: &std::path::Path) -> InstallationRecord {
        InstallationRecord {
            schema_version: 1,
            installation_id: "00000000-0000-4000-8000-000000000001".to_string(),
            remote_machine_id: "machine".to_string(),
            agent_version: "0.1.9".to_string(),
            protocol_version: "1.11".to_string(),
            target: "linux-x86_64".to_string(),
            install_root: path.parent().unwrap().to_path_buf(),
            install_path: path.to_path_buf(),
            source: "test".to_string(),
            manifest_url: String::new(),
            artifact_sha256: "a".repeat(64),
            installed_at: 1,
            previous_version: String::new(),
        }
    }

    #[test]
    fn kimi_source_uses_native_root_and_exact_owner_token() {
        let installation = installation_record_for_test(std::path::Path::new(
            "/opt/cli-manager/cli-manager-ssh-agent",
        ));
        assert_eq!(Source::Kimi.default_dir(), ".kimi-code");
        assert_eq!(Source::Kimi.required_entries(), 9);
        assert_eq!(
            hook_command(&installation, Source::Kimi, "PermissionResult"),
            "'/opt/cli-manager/cli-manager-ssh-agent' hook --source kimi --event PermissionResult --owner cli-manager-ssh-agent:00000000-0000-4000-8000-000000000001 --managed-by cli-manager-ssh-agent --installation-id 00000000-0000-4000-8000-000000000001"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kimi_plan_uses_single_config_role_and_omits_history_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let root_path = temp.path().join(".kimi-code");
        fs::create_dir_all(&root_path).unwrap();
        fs::write(
            root_path.join("config.toml"),
            "# keep\nmodel = \"kimi-k2\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"third-party\"\n",
        )
        .unwrap();
        let canonical = fs::canonicalize(&root_path).unwrap();
        let root = ResolvedRoot {
            configured: "~/.kimi-code".to_string(),
            requested: root_path,
            canonical,
            hash: "a".repeat(64),
            existed: true,
        };
        let installation = installation_record_for_test(std::path::Path::new(
            "/opt/cli-manager/cli-manager-ssh-agent",
        ));

        let (plans, managed, conflict) =
            plan_files(&root, Source::Kimi, &installation, Some(true)).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].before.role, "kimiConfig");
        assert_eq!(managed, 9);
        assert!(!conflict);
        let content = String::from_utf8(plans[0].after.clone()).unwrap();
        assert!(content.contains("# keep"));
        assert!(content.contains("third-party"));
        assert_eq!(content.matches("--source kimi").count(), 9);

        let record = installation_record(Source::Kimi, &root, &installation, &plans);
        assert!(record.history_source_candidate.is_none());
    }

    #[test]
    fn grok_source_uses_native_root_and_permission_request_command() {
        let installation = installation_record_for_test(std::path::Path::new(
            "/opt/cli-manager/cli-manager-ssh-agent",
        ));
        assert_eq!(Source::Grok.default_dir(), ".grok");
        assert_eq!(Source::Grok.required_entries(), 11);
        assert_eq!(
            hook_command(&installation, Source::Grok, "PermissionRequest"),
            "'/opt/cli-manager/cli-manager-ssh-agent' hook --source grok --event PermissionRequest --managed-by cli-manager-ssh-agent --installation-id 00000000-0000-4000-8000-000000000001"
        );
    }

    fn grok_compat_doc(text: &str) -> toml_edit::DocumentMut {
        parse_toml(&FileState {
            role: "grokCompat",
            logical_path: "config.toml".into(),
            canonical_path: "config.toml".into(),
            bytes: text.as_bytes().to_vec(),
            exists: true,
            mode: None,
        })
        .expect("grok compat toml")
    }

    #[test]
    fn grok_compat_isolated_reads_nested_and_dotted_tables() {
        assert!(!grok_compat_isolated(&grok_compat_doc(
            "[compat.claude]\nskills = true\n"
        )));
        assert!(grok_compat_isolated(&grok_compat_doc(
            "[compat.claude]\nhooks = false\n[compat.cursor]\nhooks = false\n"
        )));
        assert!(grok_compat_isolated(&grok_compat_doc(
            "compat.claude.hooks = false\ncompat.cursor.hooks = false\n"
        )));
        assert!(grok_compat_isolated(&grok_compat_doc(
            "[compat]\nclaude.hooks = false\ncursor.hooks = false\n"
        )));
        assert!(!grok_compat_isolated(&grok_compat_doc(
            "[compat.claude]\nhooks = false\n[compat.cursor]\nhooks = true\n"
        )));
    }

    #[test]
    fn grok_compat_uninstall_restores_owned_values_and_preserves_user_values() {
        let mut document = grok_compat_doc(
            "# keep\n[compat.claude]\nhooks = true # claude user comment\nskills = true\n[compat.cursor]\nhooks = false # cursor user choice\n",
        );

        install_grok_compat_isolation(&mut document, "installation-1").unwrap();
        let installed = document.to_string();
        assert!(grok_compat_isolated(&document));
        assert!(installed.contains("hooks = false # claude user comment # cli-manager-ssh-agent"));
        assert!(installed.contains("hooks = false # cursor user choice"));
        assert_eq!(installed.matches("cli-manager-ssh-agent").count(), 1);

        uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();
        let restored = document.to_string();
        assert!(restored.contains("hooks = true # claude user comment"));
        assert!(restored.contains("hooks = false # cursor user choice"));
        assert!(!restored.contains("cli-manager-ssh-agent"));
        assert!(restored.contains("skills = true"));
    }

    #[test]
    fn grok_compat_uninstall_removes_only_agent_created_tables() {
        let mut document = grok_compat_doc("# keep\n[other]\nvalue = true\n");

        install_grok_compat_isolation(&mut document, "installation-1").unwrap();
        assert!(grok_compat_isolated(&document));
        assert!(document.contains_key("compat"));

        uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();
        assert!(!document.contains_key("compat"));
        let restored = document.to_string();
        assert!(restored.contains("# keep"));
        assert!(restored.contains("[other]"));
        assert!(restored.contains("value = true"));
    }

    #[test]
    fn grok_compat_uninstall_respects_other_installations_and_user_changes() {
        let mut document =
            grok_compat_doc("[compat.claude]\nhooks = true\n[compat.cursor]\nhooks = true\n");
        install_grok_compat_isolation(&mut document, "installation-1").unwrap();

        uninstall_grok_compat_isolation(&mut document, "installation-2").unwrap();
        assert!(grok_compat_isolated(&document));
        assert!(document.to_string().contains("installation=installation-1"));

        document["compat"]["claude"]["hooks"] = toml_edit::value(true);
        uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();
        assert_eq!(document["compat"]["claude"]["hooks"].as_bool(), Some(true));
        assert_eq!(document["compat"]["cursor"]["hooks"].as_bool(), Some(true));
    }

    #[test]
    fn grok_compat_already_isolated_without_marker_remains_unchanged() {
        let original =
            "[compat.claude]\nhooks = false # user\n[compat.cursor]\nhooks = false # user\n";
        let mut document = grok_compat_doc(original);

        install_grok_compat_isolation(&mut document, "installation-1").unwrap();
        uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();

        assert_eq!(document.to_string(), original);
    }

    #[test]
    fn grok_compat_uninstall_ignores_incomplete_markers() {
        let original =
            "[compat.claude]\nhooks = false # cli-manager-ssh-agent installation=installation-1\n";
        let mut document = grok_compat_doc(original);

        uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();

        assert_eq!(document.to_string(), original);
    }

    #[test]
    fn grok_compat_install_and_uninstall_preserve_supported_dotted_forms() {
        for original in [
            "compat.claude.hooks = true\ncompat.cursor.hooks = true\n",
            "[compat]\nclaude.hooks = true\ncursor.hooks = true\n",
        ] {
            let mut document = grok_compat_doc(original);
            install_grok_compat_isolation(&mut document, "installation-1").unwrap();
            assert!(grok_compat_isolated(&document));

            uninstall_grok_compat_isolation(&mut document, "installation-1").unwrap();
            assert!(!grok_compat_isolated(&document));
            assert_eq!(document["compat"]["claude"]["hooks"].as_bool(), Some(true));
            assert_eq!(document["compat"]["cursor"]["hooks"].as_bool(), Some(true));
            assert!(!document.to_string().contains("cli-manager-ssh-agent"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn grok_plan_writes_hooks_json_and_compat_and_omits_history_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let root_path = temp.path().join(".grok");
        fs::create_dir_all(root_path.join("hooks")).unwrap();
        fs::write(
            root_path.join("hooks").join("cli-manager.json"),
            "{\n  \"keep\": true\n}\n",
        )
        .unwrap();
        fs::write(
            root_path.join("config.toml"),
            "# keep\n[compat.claude]\nhooks = true\nskills = true\n",
        )
        .unwrap();
        let canonical = fs::canonicalize(&root_path).unwrap();
        let root = ResolvedRoot {
            configured: "~/.grok".to_string(),
            requested: root_path.clone(),
            canonical,
            hash: "a".repeat(64),
            existed: true,
        };
        let installation = installation_record_for_test(std::path::Path::new(
            "/opt/cli-manager/cli-manager-ssh-agent",
        ));

        let (plans, _, conflict) =
            plan_files(&root, Source::Grok, &installation, Some(true)).unwrap();
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].before.role, "grokHooks");
        assert_eq!(plans[1].before.role, "grokCompat");
        assert!(!conflict);
        let hooks = String::from_utf8(plans[0].after.clone()).unwrap();
        assert!(hooks.contains("\"keep\": true"));
        assert_eq!(hooks.matches("--source grok").count(), 11);
        assert!(hooks.contains("PermissionRequest"));
        let after_json = serde_json::from_slice(&plans[0].after).unwrap();
        let expected = exact_commands(&installation, Source::Grok);
        let (managed, after_conflict, _) =
            inspect_json(&after_json, Source::Grok, &expected).unwrap();
        assert_eq!(managed, 11);
        assert!(!after_conflict);
        let config = String::from_utf8(plans[1].after.clone()).unwrap();
        assert!(config.contains("# keep"));
        assert!(config.contains("skills = true"));
        assert!(config.contains("hooks = false"));

        let record = installation_record(Source::Grok, &root, &installation, &plans);
        assert!(record.history_source_candidate.is_none());

        let inspect_plans = plan_files(&root, Source::Grok, &installation, None)
            .unwrap()
            .0;
        assert!(!grok_compat_isolated(
            &parse_toml(&inspect_plans[1].before).unwrap()
        ));
        let after_toml = parse_toml(&FileState {
            role: "grokCompat",
            logical_path: inspect_plans[1].before.logical_path.clone(),
            canonical_path: inspect_plans[1].before.canonical_path.clone(),
            bytes: plans[1].after.clone(),
            exists: true,
            mode: None,
        })
        .unwrap();
        assert!(grok_compat_isolated(&after_toml));

        fs::write(root_path.join("config.toml"), &plans[1].after).unwrap();
        let uninstall_plans = plan_files(&root, Source::Grok, &installation, Some(false))
            .unwrap()
            .0;
        let restored = String::from_utf8(uninstall_plans[1].after.clone()).unwrap();
        assert!(restored.contains("hooks = true"));
        assert!(restored.contains("skills = true"));
        assert!(!restored.contains("cli-manager-ssh-agent"));
    }

    #[cfg(unix)]
    #[test]
    fn kimi_candidate_failure_leaves_live_config_untouched() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config.toml");
        fs::write(&config, "model = \"kimi-k2\"\n").unwrap();
        let doctor = temp.path().join("kimi");
        fs::write(&doctor, "#!/bin/sh\nexit 2\n").unwrap();
        fs::set_permissions(&doctor, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(
            validate_kimi_candidate(&doctor, &config, b"model = \"other\"\n").unwrap_err(),
            "hook_config_doctor_failed"
        );
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            "model = \"kimi-k2\"\n"
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn kimi_capability_rejects_legacy_cli_and_accepts_current_cli() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("current-kimi");
        fs::write(&current, "#!/bin/sh\n[ \"$1\" = doctor ]\n").unwrap();
        fs::set_permissions(&current, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(supports_current_kimi(&current));

        let legacy = temp.path().join("legacy-kimi");
        fs::write(&legacy, "#!/bin/sh\nexit 2\n").unwrap();
        fs::set_permissions(&legacy, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(!supports_current_kimi(&legacy));
    }

    #[test]
    fn exact_owner_merge_preserves_third_party_entries() {
        let mut value = json!({
            "permissions": { "allow": ["Read"] },
            "hooks": {
                "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "third-party" }] }]
            }
        });
        let expected = HashMap::from([
            ("SessionStart", "agent SessionStart".to_string()),
            ("UserPromptSubmit", "agent UserPromptSubmit".to_string()),
            ("Notification", "agent Notification".to_string()),
            ("Stop", "agent Stop".to_string()),
            ("StopFailure", "agent StopFailure".to_string()),
            ("SubagentStart", "agent SubagentStart".to_string()),
            ("SubagentStop", "agent SubagentStop".to_string()),
            ("AgentToolStart", "agent AgentToolStart".to_string()),
            ("AgentToolStop", "agent AgentToolStop".to_string()),
            ("ToolStart", "agent ToolStart".to_string()),
            ("ToolStop", "agent ToolStop".to_string()),
        ]);
        add_exact_hooks(&mut value, Source::Claude, &expected).unwrap();
        assert_eq!(
            inspect_json(&value, Source::Claude, &expected).unwrap().0,
            12
        );
        remove_exact_hooks(&mut value, Source::Claude, &expected).unwrap();
        assert_eq!(
            value["hooks"]["Stop"][0]["hooks"][0]["command"],
            "third-party"
        );
        assert_eq!(value["permissions"]["allow"][0], "Read");
    }

    #[test]
    fn marker_only_matches_same_installation() {
        let marker = feature_marker("installation-1", "false", false);
        assert_eq!(
            parse_owned_marker(&marker, "installation-1"),
            Some(("false".to_string(), false, " ".to_string()))
        );
        assert_eq!(parse_owned_marker(&marker, "installation-2"), None);
    }

    #[test]
    fn duplicate_exact_entries_are_outdated_but_removable() {
        let mut value = json!({});
        let expected = HashMap::from([
            ("SessionStart", "agent SessionStart".to_string()),
            ("UserPromptSubmit", "agent UserPromptSubmit".to_string()),
            ("Notification", "agent Notification".to_string()),
            ("PermissionRequest", "agent PermissionRequest".to_string()),
            ("Stop", "agent Stop".to_string()),
            ("SubagentStart", "agent SubagentStart".to_string()),
            ("SubagentStop", "agent SubagentStop".to_string()),
        ]);
        add_exact_hooks(&mut value, Source::Codex, &expected).unwrap();
        let duplicate = value["hooks"]["Stop"][0].clone();
        value["hooks"]["Stop"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        let (managed, conflict, outdated) = inspect_json(&value, Source::Codex, &expected).unwrap();
        assert_eq!(managed, 7);
        assert!(!conflict);
        assert!(outdated);
        add_exact_hooks(&mut value, Source::Codex, &expected).unwrap();
        let (managed, conflict, outdated) = inspect_json(&value, Source::Codex, &expected).unwrap();
        assert_eq!(managed, 7);
        assert!(!conflict);
        assert!(!outdated);
        remove_exact_hooks(&mut value, Source::Codex, &expected).unwrap();
        assert!(value.get("hooks").is_none());
    }

    #[test]
    fn codex_feature_uninstall_restores_only_owned_changes() {
        let mut disabled = "[features]\nhooks = false # keep this\n".parse().unwrap();
        install_codex_feature(&mut disabled, "installation-1").unwrap();
        assert!(disabled.to_string().contains("cli-manager-ssh-agent"));
        uninstall_codex_feature(&mut disabled, "installation-1").unwrap();
        assert!(disabled.to_string().contains("hooks = false # keep this"));

        let mut user_enabled = "[features]\nhooks = true # user\n".parse().unwrap();
        install_codex_feature(&mut user_enabled, "installation-1").unwrap();
        uninstall_codex_feature(&mut user_enabled, "installation-1").unwrap();
        assert!(user_enabled.to_string().contains("hooks = true # user"));
    }

    fn test_layout(root: &std::path::Path) -> AgentLayout {
        let state_dir = root.join("state");
        AgentLayout {
            home: root.join("home"),
            data_dir: root.join("data"),
            runtime_dir: root.join("run"),
            installation_record: state_dir.join("installation.json"),
            state_dir,
        }
    }

    #[cfg(unix)]
    fn write_hook_record(
        layout: &AgentLayout,
        source: Source,
        configured: &std::path::Path,
        canonical: &std::path::Path,
    ) {
        let hash = super::config_root_hash(canonical);
        let records = layout.state_dir.join("hooks/installations");
        fs::create_dir_all(&records).unwrap();
        fs::write(
            records.join(format!("{}-{hash}.json", source.as_str())),
            serde_json::to_vec(&json!({
                "source": source.as_str(),
                "installationId": "00000000-0000-4000-8000-000000000001",
                "ownerId": "cli-manager-ssh-agent:00000000-0000-4000-8000-000000000001",
                "configuredConfigRoot": configured.to_string_lossy(),
                "canonicalConfigRoot": canonical.to_string_lossy(),
                "configFiles": [],
                "managedEntries": source.required_entries(),
                "adapterVersion": 1,
                "installedAt": 1,
                "historySourceCandidate": matches!(source, Source::Claude | Source::Codex).then(|| json!({
                    "source": source.as_str(),
                    "canonicalConfigRoot": canonical.to_string_lossy(),
                    "configRootHash": hash,
                }))
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn test_plan(path: &std::path::Path, before: &[u8], after: &[u8]) -> PlannedFile {
        PlannedFile {
            before: FileState {
                role: "test",
                logical_path: path.to_path_buf(),
                canonical_path: fs::canonicalize(path).unwrap(),
                bytes: before.to_vec(),
                exists: true,
                mode: None,
            },
            after: after.to_vec(),
            after_exists: true,
        }
    }

    #[test]
    fn transaction_rejects_external_change_without_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        fs::write(&path, b"before").unwrap();
        let plan = test_plan(&path, b"before", b"after");
        fs::write(&path, b"external").unwrap();
        assert_eq!(
            apply_transaction(&test_layout(temp.path()), "root", &[plan]).unwrap_err(),
            "hook_config_changed"
        );
        assert_eq!(fs::read(&path).unwrap(), b"external");
    }

    #[test]
    fn transaction_preflights_all_targets_before_first_write() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first.json");
        let second = temp.path().join("second.json");
        let replacement = temp.path().join("replacement.json");
        fs::write(&first, b"first-before").unwrap();
        fs::write(&second, b"second-before").unwrap();
        fs::write(&replacement, b"replacement").unwrap();
        let first_plan = test_plan(&first, b"first-before", b"first-after");
        let mut second_plan = test_plan(&second, b"second-before", b"second-after");
        second_plan.before.logical_path = replacement;
        assert_eq!(
            apply_transaction(
                &test_layout(temp.path()),
                "root",
                &[first_plan, second_plan]
            )
            .unwrap_err(),
            "hook_config_root_changed"
        );
        assert_eq!(fs::read(&first).unwrap(), b"first-before");
        assert_eq!(fs::read(&second).unwrap(), b"second-before");
    }

    #[test]
    fn recovery_restores_safe_files_and_preserves_external_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let layout = test_layout(temp.path());
        let first = temp.path().join("first.json");
        let second = temp.path().join("second.json");
        fs::write(&first, b"first-after").unwrap();
        fs::write(&second, b"external").unwrap();
        let directory = transaction_dir(&layout, "root");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("0.before"), b"first-before").unwrap();
        fs::write(directory.join("1.before"), b"second-before").unwrap();
        fs::write(
            directory.join("journal.json"),
            serde_json::to_vec(&TransactionJournal {
                files: vec![
                    TransactionFile {
                        role: "first".to_string(),
                        canonical_path: fs::canonicalize(&first)
                            .unwrap()
                            .to_string_lossy()
                            .to_string(),
                        existed: true,
                        before_fingerprint: fingerprint(Some(b"first-before")),
                        after_fingerprint: fingerprint(Some(b"first-after")),
                        mode: None,
                        backup_name: "0.before".to_string(),
                    },
                    TransactionFile {
                        role: "second".to_string(),
                        canonical_path: fs::canonicalize(&second)
                            .unwrap()
                            .to_string_lossy()
                            .to_string(),
                        existed: true,
                        before_fingerprint: fingerprint(Some(b"second-before")),
                        after_fingerprint: fingerprint(Some(b"second-after")),
                        mode: None,
                        backup_name: "1.before".to_string(),
                    },
                ],
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            recover_transaction(&layout, "root").unwrap_err(),
            "hook_config_recovery_conflict"
        );
        assert_eq!(fs::read(&first).unwrap(), b"first-before");
        assert_eq!(fs::read(&second).unwrap(), b"external");
    }

    #[cfg(unix)]
    #[test]
    fn config_symlink_resolves_to_the_real_target() {
        use super::{resolve_config_file, ResolvedRoot};
        use std::fs;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        let target = temp.path().join("settings-target.json");
        fs::write(&target, b"{}\n").unwrap();
        symlink(&target, root.join("settings.json")).unwrap();
        let resolved = ResolvedRoot {
            configured: root.to_string_lossy().to_string(),
            requested: root.clone(),
            canonical: fs::canonicalize(&root).unwrap(),
            hash: "hash".to_string(),
            existed: true,
        };
        let state = resolve_config_file(&resolved, "claudeSettings", "settings.json").unwrap();
        assert_eq!(state.canonical_path, fs::canonicalize(target).unwrap());
    }

    #[test]
    fn unrelated_hook_event_shapes_are_preserved() {
        let value = json!({
            "hooks": {
                "FutureEvent": { "schema": 2 },
                "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "third-party" }] }]
            }
        });
        let expected = Source::Claude
            .hooks()
            .iter()
            .map(|(_, command_event, _)| (*command_event, format!("agent {command_event}")))
            .collect();
        assert_eq!(
            inspect_json(&value, Source::Claude, &expected).unwrap(),
            (0, false, false)
        );
        assert_eq!(value["hooks"]["FutureEvent"]["schema"], 2);
    }

    #[cfg(unix)]
    #[test]
    fn config_symlink_target_change_is_rejected() {
        use super::{resolve_config_file, ResolvedRoot};
        use std::fs;
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir_all(&root).unwrap();
        let first = temp.path().join("first.json");
        let second = temp.path().join("second.json");
        fs::write(&first, b"{}\n").unwrap();
        fs::write(&second, b"{}\n").unwrap();
        let logical = root.join("settings.json");
        symlink(&first, &logical).unwrap();
        let resolved = ResolvedRoot {
            configured: root.to_string_lossy().to_string(),
            requested: root.clone(),
            canonical: fs::canonicalize(&root).unwrap(),
            hash: "hash".to_string(),
            existed: true,
        };
        let state = resolve_config_file(&resolved, "claudeSettings", "settings.json").unwrap();
        fs::remove_file(&logical).unwrap();
        symlink(&second, &logical).unwrap();
        assert_eq!(
            config_target_unchanged(&state).unwrap_err(),
            "hook_config_root_changed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn config_root_symlink_target_change_before_planning_is_rejected() {
        use super::{resolve_config_file, resolve_root};
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let layout = test_layout(temp.path());
        fs::create_dir_all(&layout.home).unwrap();
        let first = layout.home.join("claude-a");
        let second = layout.home.join("claude-b");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let configured = layout.home.join("claude-current");
        symlink(&first, &configured).unwrap();
        let resolved = resolve_root(
            configured.to_string_lossy().as_ref(),
            Source::Claude,
            &layout,
            false,
        )
        .unwrap();

        fs::remove_file(&configured).unwrap();
        symlink(&second, &configured).unwrap();
        assert_eq!(
            resolve_config_file(&resolved, "claudeSettings", "settings.json").unwrap_err(),
            "hook_config_root_changed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn deleted_custom_root_can_be_recovered_for_record_cleanup() {
        use super::resolve_uninstall_root;
        use crate::layout::AgentLayout;
        use std::fs;

        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let custom = home.join("custom-claude");
        fs::create_dir_all(&custom).unwrap();
        let canonical = fs::canonicalize(&custom).unwrap();
        fs::remove_dir(&custom).unwrap();
        let state_dir = temp.path().join("state");
        let layout = AgentLayout {
            home: home.clone(),
            data_dir: temp.path().join("data"),
            state_dir: state_dir.clone(),
            runtime_dir: temp.path().join("run"),
            installation_record: state_dir.join("installation.json"),
        };
        write_hook_record(&layout, Source::Claude, &custom, &canonical);
        let recovered = resolve_uninstall_root(
            custom.to_string_lossy().as_ref(),
            None,
            Source::Claude,
            &layout,
        )
        .unwrap();
        assert!(!recovered.existed);
        assert_eq!(recovered.canonical, canonical);
    }

    #[cfg(unix)]
    #[test]
    fn retained_uninstall_uses_recorded_root_after_symlink_retarget() {
        use super::{resolve_config_file, resolve_uninstall_root};
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let layout = test_layout(temp.path());
        fs::create_dir_all(&layout.home).unwrap();
        let first = layout.home.join("claude-a");
        let second = layout.home.join("claude-b");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let first = fs::canonicalize(first).unwrap();
        let second = fs::canonicalize(second).unwrap();
        let configured = layout.home.join("claude-current");
        symlink(&first, &configured).unwrap();
        write_hook_record(&layout, Source::Claude, &configured, &first);

        fs::remove_file(&configured).unwrap();
        symlink(&second, &configured).unwrap();

        let current = resolve_uninstall_root(
            configured.to_string_lossy().as_ref(),
            None,
            Source::Claude,
            &layout,
        )
        .unwrap();
        assert_eq!(current.canonical, second);
        assert_eq!(
            resolve_config_file(&current, "claudeSettings", "settings.json")
                .unwrap()
                .canonical_path,
            second.join("settings.json")
        );

        let retained = resolve_uninstall_root(
            configured.to_string_lossy().as_ref(),
            Some(first.to_string_lossy().as_ref()),
            Source::Claude,
            &layout,
        )
        .unwrap();
        assert_eq!(retained.canonical, first);
        assert_eq!(retained.requested, first);
        assert_eq!(
            resolve_config_file(&retained, "claudeSettings", "settings.json")
                .unwrap()
                .canonical_path,
            retained.canonical.join("settings.json")
        );
    }
}
