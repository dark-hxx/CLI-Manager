use super::{hook_command, FileState, Source};
use crate::installer::InstallationRecord;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub(super) fn read_json(state: &FileState) -> Result<Value, String> {
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

pub(super) fn command_values(value: &Value) -> impl Iterator<Item = &str> {
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

pub(super) fn exact_commands(
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

pub(super) fn inspect_json(
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

pub(super) fn hooks_object(value: &mut Value) -> Result<&mut Map<String, Value>, String> {
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

pub(super) fn add_exact_hooks(
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

pub(super) fn remove_exact_hooks(
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

pub(super) fn serialize_json(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| "hook_config_json_serialize_failed".to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}
