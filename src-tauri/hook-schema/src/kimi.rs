use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use toml_edit::{ArrayOfTables, DocumentMut, Item, Table, Value};

pub const LOCAL_OWNER: &str = "cli-manager-local";
pub const SSH_OWNER_PREFIX: &str = "cli-manager-ssh-agent:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum KimiHookModule {
    SessionStart,
    Running,
    Attention,
    Stop,
    Failure,
    Subagent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KimiHookDefinition {
    pub module: KimiHookModule,
    pub native_event: &'static str,
    pub bridge_event: &'static str,
    pub matcher: &'static str,
}

pub const DEFINITIONS: [KimiHookDefinition; 9] = [
    KimiHookDefinition {
        module: KimiHookModule::SessionStart,
        native_event: "SessionStart",
        bridge_event: "SessionStart",
        matcher: "",
    },
    KimiHookDefinition {
        module: KimiHookModule::Running,
        native_event: "TurnStarted",
        bridge_event: "UserPromptSubmit",
        matcher: "",
    },
    KimiHookDefinition {
        module: KimiHookModule::Attention,
        native_event: "PermissionRequest",
        bridge_event: "PermissionRequest",
        matcher: "",
    },
    KimiHookDefinition {
        module: KimiHookModule::Attention,
        native_event: "PermissionResult",
        bridge_event: "PermissionResult",
        matcher: "",
    },
    KimiHookDefinition {
        module: KimiHookModule::Stop,
        native_event: "Stop",
        bridge_event: "Stop",
        matcher: "",
    },
    KimiHookDefinition {
        module: KimiHookModule::Stop,
        native_event: "Interrupt",
        bridge_event: "Interrupt",
        matcher: "",
    },
    KimiHookDefinition {
        module: KimiHookModule::Failure,
        native_event: "StopFailure",
        bridge_event: "StopFailure",
        matcher: "",
    },
    KimiHookDefinition {
        module: KimiHookModule::Subagent,
        native_event: "SubagentStart",
        bridge_event: "SubagentStart",
        matcher: "",
    },
    KimiHookDefinition {
        module: KimiHookModule::Subagent,
        native_event: "SubagentStop",
        bridge_event: "SubagentStop",
        matcher: "",
    },
];

pub const ALL_MODULES: [KimiHookModule; 6] = [
    KimiHookModule::SessionStart,
    KimiHookModule::Running,
    KimiHookModule::Attention,
    KimiHookModule::Stop,
    KimiHookModule::Failure,
    KimiHookModule::Subagent,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KimiPlanAction {
    Inspect,
    Install,
    Uninstall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KimiPlan {
    pub content: String,
    pub managed_entries: u32,
    pub installed_bridge_events: BTreeSet<String>,
    pub outdated: bool,
    pub conflict: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedCommand {
    executable: String,
    source: String,
    owner: String,
    bridge_event: String,
    installation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateKind {
    ThirdParty,
    Exact,
    Outdated,
    Conflict,
}

pub fn plan(
    original: &str,
    expected_commands: &BTreeMap<String, String>,
    target_modules: &[KimiHookModule],
    action: KimiPlanAction,
) -> Result<KimiPlan, String> {
    let expected = parse_expected_commands(expected_commands)?;
    let expected_owner = expected
        .values()
        .next()
        .map(|command| command.owner.as_str())
        .ok_or_else(|| "kimi_expected_commands_missing".to_string())?;
    let mut document =
        DocumentMut::from_str(original).map_err(|_| "hook_config_toml_invalid".to_string())?;
    validate_hooks_shape(&document)?;

    let targets: BTreeSet<KimiHookModule> = target_modules.iter().copied().collect();
    if targets.is_empty() {
        return Err("kimi_hook_module_required".to_string());
    }
    let target_definitions: Vec<&KimiHookDefinition> = DEFINITIONS
        .iter()
        .filter(|definition| targets.contains(&definition.module))
        .collect();
    let mut exact_seen = BTreeSet::new();
    let mut installed_bridge_events = BTreeSet::new();
    let mut remove_indices = Vec::new();
    let mut outdated = false;
    let mut conflict = false;

    if let Some(hooks) = document.get("hooks").and_then(Item::as_array_of_tables) {
        for (index, table) in hooks.iter().enumerate() {
            let native_event = table
                .get("event")
                .and_then(Item::as_str)
                .expect("validated Kimi hook event");
            let command = table
                .get("command")
                .and_then(Item::as_str)
                .expect("validated Kimi hook command");
            let matcher = table.get("matcher").and_then(Item::as_str).unwrap_or("");
            let parsed = parse_command(command);
            let definition = DEFINITIONS
                .iter()
                .find(|definition| definition.native_event == native_event);
            let kind = classify_candidate(
                parsed.as_ref(),
                definition,
                matcher,
                expected_owner,
                &expected,
            );
            let targeted =
                definition.is_some_and(|definition| targets.contains(&definition.module));
            if !targeted && matches!(kind, CandidateKind::Exact | CandidateKind::Outdated) {
                continue;
            }
            match kind {
                CandidateKind::ThirdParty => {}
                CandidateKind::Conflict => conflict = true,
                CandidateKind::Outdated => {
                    outdated = true;
                    if action == KimiPlanAction::Install
                        || (action == KimiPlanAction::Uninstall
                            && parsed.is_some_and(|command| command.owner == expected_owner))
                    {
                        remove_indices.push(index);
                    }
                }
                CandidateKind::Exact => {
                    let definition = definition.expect("exact entry has definition");
                    if exact_seen.insert(definition.bridge_event) {
                        installed_bridge_events.insert(definition.bridge_event.to_string());
                        if action == KimiPlanAction::Uninstall {
                            remove_indices.push(index);
                        }
                    } else {
                        outdated = true;
                        if matches!(action, KimiPlanAction::Install | KimiPlanAction::Uninstall) {
                            remove_indices.push(index);
                        }
                    }
                }
            }
        }
    }

    if conflict && action != KimiPlanAction::Inspect {
        return Err("hook_config_owner_conflict".to_string());
    }

    let original_document = document.to_string();
    if action != KimiPlanAction::Inspect {
        if let Some(hooks) = document
            .get_mut("hooks")
            .and_then(Item::as_array_of_tables_mut)
        {
            remove_indices.sort_unstable();
            remove_indices.dedup();
            for index in remove_indices.into_iter().rev() {
                hooks.remove(index);
            }
        }
        if action == KimiPlanAction::Install {
            let hooks = ensure_hooks(&mut document)?;
            for definition in &target_definitions {
                if installed_bridge_events.contains(definition.bridge_event) {
                    continue;
                }
                let command = expected_commands
                    .get(definition.bridge_event)
                    .ok_or_else(|| "kimi_expected_command_missing".to_string())?;
                let mut table = Table::new();
                table.insert("event", Item::Value(Value::from(definition.native_event)));
                if !definition.matcher.is_empty() {
                    table.insert("matcher", Item::Value(Value::from(definition.matcher)));
                }
                table.insert("command", Item::Value(Value::from(command.as_str())));
                table.insert("timeout", Item::Value(Value::from(5_i64)));
                hooks.push(table);
                installed_bridge_events.insert(definition.bridge_event.to_string());
            }
        }
        if document
            .get("hooks")
            .and_then(Item::as_array_of_tables)
            .is_some_and(ArrayOfTables::is_empty)
        {
            document.remove("hooks");
        }
    }

    let content = if document.to_string() == original_document {
        original.to_string()
    } else {
        document.to_string()
    };
    let managed_entries = target_definitions
        .iter()
        .filter(|definition| installed_bridge_events.contains(definition.bridge_event))
        .count() as u32;
    Ok(KimiPlan {
        content,
        managed_entries,
        installed_bridge_events,
        outdated,
        conflict,
    })
}

fn parse_expected_commands(
    commands: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, ParsedCommand>, String> {
    let mut parsed = BTreeMap::new();
    let mut owner = None;
    for definition in DEFINITIONS {
        let command = commands
            .get(definition.bridge_event)
            .ok_or_else(|| "kimi_expected_command_missing".to_string())?;
        let value =
            parse_command(command).ok_or_else(|| "kimi_expected_command_invalid".to_string())?;
        if value.source != "kimi" || value.bridge_event != definition.bridge_event {
            return Err("kimi_expected_command_invalid".to_string());
        }
        if owner.as_deref().is_some_and(|owner| owner != value.owner) {
            return Err("kimi_expected_owner_mismatch".to_string());
        }
        owner = Some(value.owner.clone());
        parsed.insert(definition.bridge_event.to_string(), value);
    }
    Ok(parsed)
}

fn validate_hooks_shape(document: &DocumentMut) -> Result<(), String> {
    let Some(item) = document.get("hooks") else {
        return Ok(());
    };
    let hooks = item
        .as_array_of_tables()
        .ok_or_else(|| "hook_config_toml_hooks_invalid".to_string())?;
    for table in hooks.iter() {
        if table.get("event").and_then(Item::as_str).is_none()
            || table.get("command").and_then(Item::as_str).is_none()
            || table
                .get("matcher")
                .is_some_and(|value| value.as_str().is_none())
            || table
                .get("timeout")
                .is_some_and(|value| value.as_integer().is_none())
        {
            return Err("hook_config_toml_hooks_invalid".to_string());
        }
    }
    Ok(())
}

fn ensure_hooks(document: &mut DocumentMut) -> Result<&mut ArrayOfTables, String> {
    if !document.contains_key("hooks") {
        document["hooks"] = Item::ArrayOfTables(ArrayOfTables::new());
    }
    document
        .get_mut("hooks")
        .and_then(Item::as_array_of_tables_mut)
        .ok_or_else(|| "hook_config_toml_hooks_invalid".to_string())
}

fn classify_candidate(
    parsed: Option<&ParsedCommand>,
    definition: Option<&KimiHookDefinition>,
    matcher: &str,
    expected_owner: &str,
    expected: &BTreeMap<String, ParsedCommand>,
) -> CandidateKind {
    let Some(parsed) = parsed else {
        return CandidateKind::ThirdParty;
    };
    if parsed.source != "kimi" {
        return CandidateKind::Conflict;
    }
    let same_owner_family = owner_family(&parsed.owner) == owner_family(expected_owner);
    if !same_owner_family {
        return if parsed.owner == LOCAL_OWNER || parsed.owner.starts_with(SSH_OWNER_PREFIX) {
            CandidateKind::Conflict
        } else {
            CandidateKind::ThirdParty
        };
    }
    let Some(definition) = definition else {
        return CandidateKind::Conflict;
    };
    if parsed.bridge_event != definition.bridge_event || matcher != definition.matcher {
        return CandidateKind::Conflict;
    }
    let Some(expected) = expected.get(definition.bridge_event) else {
        return CandidateKind::Conflict;
    };
    if parsed == expected {
        CandidateKind::Exact
    } else {
        CandidateKind::Outdated
    }
}

fn owner_family(owner: &str) -> Option<&'static str> {
    if owner == LOCAL_OWNER {
        Some("local")
    } else if owner.starts_with(SSH_OWNER_PREFIX) {
        Some("ssh")
    } else {
        None
    }
}

fn parse_command(command: &str) -> Option<ParsedCommand> {
    let tokens = shell_tokens(command)?;
    match tokens.as_slice() {
        [executable, marker, source_flag, source, event_flag, event, owner_flag, owner]
            if marker == "__hook"
                && source_flag == "--source"
                && event_flag == "--event"
                && owner_flag == "--owner"
                && owner == LOCAL_OWNER =>
        {
            Some(ParsedCommand {
                executable: executable.clone(),
                source: source.clone(),
                owner: owner.clone(),
                bridge_event: event.clone(),
                installation_id: None,
            })
        }
        [executable, marker, source_flag, source, event_flag, event, owner_flag, owner, managed_flag, managed, installation_flag, installation]
            if marker == "hook"
                && source_flag == "--source"
                && event_flag == "--event"
                && owner_flag == "--owner"
                && owner.starts_with(SSH_OWNER_PREFIX)
                && managed_flag == "--managed-by"
                && managed == "cli-manager-ssh-agent"
                && installation_flag == "--installation-id"
                && owner.strip_prefix(SSH_OWNER_PREFIX) == Some(installation.as_str()) =>
        {
            Some(ParsedCommand {
                executable: executable.clone(),
                source: source.clone(),
                owner: owner.clone(),
                bridge_event: event.clone(),
                installation_id: Some(installation.clone()),
            })
        }
        _ => None,
    }
}

fn shell_tokens(command: &str) -> Option<Vec<String>> {
    const POWERSHELL_PREFIX: &str = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& ";
    if let Some(inner) = command.strip_prefix(POWERSHELL_PREFIX) {
        let inner = inner.strip_suffix('"')?;
        return powershell_inner_tokens(inner);
    }
    posix_tokens(command)
}

fn powershell_inner_tokens(command: &str) -> Option<Vec<String>> {
    let rest = command.strip_prefix('\'')?;
    let mut executable = String::new();
    let mut chars = rest.char_indices().peekable();
    let mut end = None;
    while let Some((index, ch)) = chars.next() {
        if ch != '\'' {
            executable.push(ch);
            continue;
        }
        if chars.peek().is_some_and(|(_, next)| *next == '\'') {
            chars.next();
            executable.push('\'');
        } else {
            end = Some(index + 1);
            break;
        }
    }
    let tail = rest.get(end?..)?.strip_prefix(' ')?;
    if tail.contains(['\'', '"', '\\']) {
        return None;
    }
    let mut tokens = vec![executable];
    tokens.extend(tail.split_ascii_whitespace().map(str::to_string));
    Some(tokens)
}

fn posix_tokens(command: &str) -> Option<Vec<String>> {
    let bytes = command.as_bytes();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut index = 0;
    let mut quoted = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' => {
                quoted = !quoted;
                index += 1;
            }
            b'\\' if !quoted => {
                index += 1;
                let next = *bytes.get(index)?;
                current.push(next as char);
                index += 1;
            }
            byte if byte.is_ascii_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                index += 1;
            }
            byte => {
                current.push(byte as char);
                index += 1;
            }
        }
    }
    if quoted {
        return None;
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    (!tokens.is_empty()).then_some(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_commands(executable: &str) -> BTreeMap<String, String> {
        DEFINITIONS
            .iter()
            .map(|definition| {
                (
                    definition.bridge_event.to_string(),
                    format!(
                        "'{executable}' __hook --source kimi --event {} --owner {LOCAL_OWNER}",
                        definition.bridge_event
                    ),
                )
            })
            .collect()
    }

    fn ssh_commands(executable: &str, installation: &str) -> BTreeMap<String, String> {
        DEFINITIONS
            .iter()
            .map(|definition| {
                (
                    definition.bridge_event.to_string(),
                    format!(
                        "'{executable}' hook --source kimi --event {} --owner {SSH_OWNER_PREFIX}{installation} --managed-by cli-manager-ssh-agent --installation-id {installation}",
                        definition.bridge_event
                    ),
                )
            })
            .collect()
    }

    #[test]
    fn installs_idempotently_and_preserves_comments_order_and_user_hooks() {
        let original = r#"# provider comment
model = "kimi-k2"

[[hooks]]
# user hook
event = "Stop"
command = "third-party --source kimi --event Stop"
timeout = 9
"#;
        let commands = local_commands("/opt/CLI Manager/cli-manager");
        let first = plan(original, &commands, &ALL_MODULES, KimiPlanAction::Install).unwrap();
        assert_eq!(first.managed_entries, 9);
        assert!(first.content.contains("# provider comment"));
        assert!(first.content.contains("# user hook"));
        assert!(first
            .content
            .contains("third-party --source kimi --event Stop"));
        let second = plan(
            &first.content,
            &commands,
            &ALL_MODULES,
            KimiPlanAction::Install,
        )
        .unwrap();
        assert_eq!(second.content, first.content);
        assert!(!second.outdated);
    }

    #[test]
    fn similar_substrings_are_never_owned_or_removed() {
        let original = r#"[[hooks]]
event = "Stop"
command = "echo __hook --source kimi --event Stop --owner cli-manager-local later"
"#;
        let commands = local_commands("/cli-manager");
        let installed = plan(original, &commands, &ALL_MODULES, KimiPlanAction::Install).unwrap();
        let removed = plan(
            &installed.content,
            &commands,
            &ALL_MODULES,
            KimiPlanAction::Uninstall,
        )
        .unwrap();
        assert!(removed.content.contains("echo __hook"));
        assert!(!removed.content.contains("'/cli-manager' __hook"));
    }

    #[test]
    fn install_converges_stale_executable_and_ssh_installation() {
        let old = ssh_commands("/old/agent", "00000000-0000-4000-8000-000000000001");
        let current = ssh_commands("/new/agent", "00000000-0000-4000-8000-000000000002");
        let installed = plan("", &old, &ALL_MODULES, KimiPlanAction::Install).unwrap();
        let inspected = plan(
            &installed.content,
            &current,
            &ALL_MODULES,
            KimiPlanAction::Inspect,
        )
        .unwrap();
        assert!(inspected.outdated);
        assert_eq!(inspected.managed_entries, 0);
        let converged = plan(
            &installed.content,
            &current,
            &ALL_MODULES,
            KimiPlanAction::Install,
        )
        .unwrap();
        assert_eq!(converged.managed_entries, 9);
        assert!(!converged.content.contains("/old/agent"));
    }

    #[test]
    fn uninstall_removes_stale_executable_only_for_the_exact_owner() {
        let old_local = local_commands("/old/cli-manager");
        let current_local = local_commands("/new/cli-manager");
        let installed_local = plan("", &old_local, &ALL_MODULES, KimiPlanAction::Install).unwrap();
        let removed_local = plan(
            &installed_local.content,
            &current_local,
            &ALL_MODULES,
            KimiPlanAction::Uninstall,
        )
        .unwrap();
        assert!(!removed_local.content.contains("--owner cli-manager-local"));

        let old_ssh = ssh_commands("/old/agent", "00000000-0000-4000-8000-000000000001");
        let current_ssh = ssh_commands("/new/agent", "00000000-0000-4000-8000-000000000002");
        let installed_ssh = plan("", &old_ssh, &ALL_MODULES, KimiPlanAction::Install).unwrap();
        let preserved_ssh = plan(
            &installed_ssh.content,
            &current_ssh,
            &ALL_MODULES,
            KimiPlanAction::Uninstall,
        )
        .unwrap();
        assert!(preserved_ssh
            .content
            .contains("cli-manager-ssh-agent:00000000-0000-4000-8000-000000000001"));
    }

    #[test]
    fn install_converges_duplicate_exact_entries() {
        let commands = local_commands("/cli-manager");
        let stop = commands.get("Stop").unwrap();
        let original = format!(
            "[[hooks]]\nevent = \"Stop\"\ncommand = {stop:?}\n\n[[hooks]]\nevent = \"Stop\"\ncommand = {stop:?}\n"
        );
        let inspected = plan(&original, &commands, &ALL_MODULES, KimiPlanAction::Inspect).unwrap();
        assert!(inspected.outdated);

        let converged = plan(&original, &commands, &ALL_MODULES, KimiPlanAction::Install).unwrap();
        assert_eq!(converged.managed_entries, 9);
        assert_eq!(
            converged
                .content
                .matches("--event Stop --owner cli-manager-local")
                .count(),
            1
        );
    }

    #[test]
    fn module_uninstall_removes_both_attention_definitions_only() {
        let commands = local_commands("/cli-manager");
        let installed = plan("", &commands, &ALL_MODULES, KimiPlanAction::Install).unwrap();
        let removed = plan(
            &installed.content,
            &commands,
            &[KimiHookModule::Attention],
            KimiPlanAction::Uninstall,
        )
        .unwrap();
        assert!(!removed.content.contains("PermissionRequest"));
        assert!(!removed.content.contains("PermissionResult"));
        assert!(removed.content.contains("TurnStarted"));
        assert!(removed.content.contains("Interrupt"));
    }

    #[test]
    fn exact_owner_with_wrong_event_is_a_conflict() {
        let commands = local_commands("/cli-manager");
        let config = r#"[[hooks]]
event = "Stop"
command = "'/cli-manager' __hook --source kimi --event Interrupt --owner cli-manager-local"
"#;
        let inspected = plan(config, &commands, &ALL_MODULES, KimiPlanAction::Inspect).unwrap();
        assert!(inspected.conflict);
        assert_eq!(
            plan(config, &commands, &ALL_MODULES, KimiPlanAction::Install).unwrap_err(),
            "hook_config_owner_conflict"
        );
    }

    #[test]
    fn exact_owner_with_wrong_source_is_a_conflict() {
        let commands = local_commands("/cli-manager");
        let config = r#"[[hooks]]
event = "Stop"
command = "'/cli-manager' __hook --source codex --event Stop --owner cli-manager-local"
"#;
        let inspected = plan(config, &commands, &ALL_MODULES, KimiPlanAction::Inspect).unwrap();
        assert!(inspected.conflict);
        assert_eq!(
            plan(config, &commands, &ALL_MODULES, KimiPlanAction::Install).unwrap_err(),
            "hook_config_owner_conflict"
        );
    }

    #[test]
    fn invalid_hooks_shape_is_explicit() {
        let commands = local_commands("/cli-manager");
        assert_eq!(
            plan(
                "hooks = {}\n",
                &commands,
                &ALL_MODULES,
                KimiPlanAction::Inspect
            )
            .unwrap_err(),
            "hook_config_toml_hooks_invalid"
        );
        assert_eq!(
            plan(
                "[[hooks]\n",
                &commands,
                &ALL_MODULES,
                KimiPlanAction::Inspect
            )
            .unwrap_err(),
            "hook_config_toml_invalid"
        );
    }

    #[test]
    fn parses_exact_powershell_command_without_substring_ownership() {
        let command = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& 'C:\\Program Files\\CLI Manager\\cli-manager.exe' __hook --source kimi --event Stop --owner cli-manager-local\"";
        let parsed = parse_command(command).unwrap();
        assert_eq!(
            parsed.executable,
            r"C:\Program Files\CLI Manager\cli-manager.exe"
        );
        assert_eq!(parsed.bridge_event, "Stop");
        assert!(parse_command(&format!("echo {command}")).is_none());
    }
}
