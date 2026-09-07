use super::{build_command, HOOK_COMMAND_MARKER};
use serde_json::{json, Map, Value};

pub(super) fn add_hook_command(settings: &mut Value, event: &str, command: String) {
    add_hook_command_with_matcher(settings, event, "", command);
}

pub(super) fn add_hook_command_with_matcher(
    settings: &mut Value,
    event: &str,
    matcher: &str,
    command: String,
) {
    let root = ensure_object(settings);
    let hooks = ensure_child_object(root, "hooks");
    let event_value = hooks
        .entry(event.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !event_value.is_array() {
        *event_value = Value::Array(Vec::new());
    }
    if event_has_exact_command(event_value, &command) {
        return;
    }
    if let Value::Array(entries) = event_value {
        entries.push(json!({
            "matcher": matcher,
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "timeout": 15
                }
            ]
        }));
    }
}

pub(super) fn remove_hook_commands(settings: &mut Value, events: &[&str], script_names: &[&str]) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };

    let mut empty_events = Vec::new();
    for event in events {
        let Some(Value::Array(entries)) = hooks.get_mut(*event) else {
            continue;
        };

        entries.retain_mut(|entry| {
            let Some(entry_object) = entry.as_object_mut() else {
                return true;
            };
            let Some(Value::Array(commands)) = entry_object.get_mut("hooks") else {
                return true;
            };
            commands.retain(|hook| !is_cli_manager_command(hook, script_names));
            !commands.is_empty()
        });

        if entries.is_empty() {
            empty_events.push((*event).to_string());
        }
    }

    for event in empty_events {
        hooks.remove(&event);
    }

    if hooks.is_empty() {
        if let Some(root) = settings.as_object_mut() {
            root.remove("hooks");
        }
    }
}

pub(super) fn remove_named_hook_command(
    settings: &mut Value,
    hook_event: &str,
    source: &str,
    command_event: &str,
) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(Value::Array(entries)) = hooks.get_mut(hook_event) else {
        return;
    };
    let source_arg = format!("--source {source}");
    let event_arg = format!("--event {command_event}");
    entries.retain_mut(|entry| {
        let Some(commands) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
            return true;
        };
        commands.retain(|hook| {
            !hook
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| {
                    command.contains(HOOK_COMMAND_MARKER)
                        && command.contains(&source_arg)
                        && command.contains(&event_arg)
                })
        });
        !commands.is_empty()
    });
    if entries.is_empty() {
        hooks.remove(hook_event);
    }
    if hooks.is_empty() {
        settings.as_object_mut().map(|root| root.remove("hooks"));
    }
}

pub(super) fn registered_exact_command(
    settings: &Value,
    exe: Option<&str>,
    hook_event: &str,
    source: &str,
    command_event: &str,
) -> bool {
    exe.is_some_and(|exe| {
        exact_command_registered(
            settings,
            hook_event,
            &build_command(exe, source, command_event),
        )
    })
}

pub(super) fn registered_exact_command_with_matcher(
    settings: &Value,
    exe: Option<&str>,
    hook_event: &str,
    source: &str,
    command_event: &str,
    matcher: &str,
) -> bool {
    exe.is_some_and(|exe| {
        exact_command_with_matcher_registered(
            settings,
            hook_event,
            matcher,
            &build_command(exe, source, command_event),
        )
    })
}

pub(super) fn exact_command_registered(settings: &Value, event: &str, command: &str) -> bool {
    settings
        .get("hooks")
        .and_then(|hooks| hooks.get(event))
        .is_some_and(|event_value| event_has_exact_command(event_value, command))
}

pub(super) fn exact_command_with_matcher_registered(
    settings: &Value,
    event: &str,
    matcher: &str,
    command: &str,
) -> bool {
    settings
        .get("hooks")
        .and_then(|hooks| hooks.get(event))
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.get("matcher").and_then(Value::as_str) == Some(matcher)
                    && entry
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|hooks| {
                            hooks.iter().any(|hook| {
                                hook.get("command").and_then(Value::as_str) == Some(command)
                            })
                        })
            })
        })
}

pub(super) fn event_has_exact_command(event_value: &Value, command: &str) -> bool {
    event_value.as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry
                .get("hooks")
                .and_then(Value::as_array)
                .is_some_and(|hooks| {
                    hooks.iter().any(|hook| {
                        hook.get("command")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value == command)
                    })
                })
        })
    })
}

pub(super) fn is_cli_manager_command(hook: &Value, legacy_scripts: &[&str]) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| {
            // 新方案命令含 __hook 标志；同时兼容识别历史 .ps1 命令，便于安装即升级/卸载清理。
            command.contains(HOOK_COMMAND_MARKER)
                || legacy_scripts
                    .iter()
                    .any(|script_name| command.contains(script_name))
        })
}

pub(super) fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value was just made object")
}

pub(super) fn ensure_child_object<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    let value = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value was just made object")
}
