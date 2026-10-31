use gpui::KeyDownEvent;
use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    ToggleCommandPalette,
    SplitPane,
    ClosePane,
    ResizeLeft,
    ResizeRight,
    ResizeUp,
    ResizeDown,
    SearchTerminal,
    CopySelection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Binding {
    key: String,
    control: bool,
    shift: bool,
    alt: bool,
    function: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Keymap {
    bindings: Vec<(Action, Binding)>,
}

impl Default for Keymap {
    fn default() -> Self {
        Self {
            bindings: vec![
                (
                    Action::ToggleCommandPalette,
                    binding("p", true, false, false, false),
                ),
                (Action::SplitPane, binding("t", true, true, false, false)),
                (Action::ClosePane, binding("w", true, false, false, false)),
                (
                    Action::ResizeLeft,
                    binding("left", true, false, true, false),
                ),
                (
                    Action::ResizeRight,
                    binding("right", true, false, true, false),
                ),
                (Action::ResizeUp, binding("up", true, false, true, false)),
                (
                    Action::ResizeDown,
                    binding("down", true, false, true, false),
                ),
                (
                    Action::SearchTerminal,
                    binding("k", true, false, false, false),
                ),
                (
                    Action::CopySelection,
                    binding("c", true, true, false, false),
                ),
            ],
        }
    }
}

impl Keymap {
    pub fn from_settings(value: Option<&Value>) -> Self {
        let mut keymap = Self::default();
        let Some(shortcuts) = value.and_then(Value::as_object) else {
            return keymap;
        };
        for (action, setting) in [
            (Action::ToggleCommandPalette, "commandPalette"),
            (Action::SplitPane, "newTerminal"),
            (Action::ClosePane, "closeTerminal"),
            (Action::SearchTerminal, "sessionHistory"),
            (Action::CopySelection, "copyTerminalSelection"),
        ] {
            if let Some(shortcut) = shortcuts.get(setting).and_then(Value::as_str) {
                if let Some(binding) = Binding::parse(shortcut) {
                    keymap.set(action, binding);
                }
            }
        }
        keymap
    }

    pub fn matches(&self, event: &KeyDownEvent, action: Action) -> bool {
        let Some((_, binding)) = self
            .bindings
            .iter()
            .find(|(candidate, _)| *candidate == action)
        else {
            return false;
        };
        let key = event.keystroke.key.to_ascii_lowercase();
        let key_matches = key == binding.key
            || (binding.key == "left" && key == "arrowleft")
            || (binding.key == "right" && key == "arrowright")
            || (binding.key == "up" && key == "arrowup")
            || (binding.key == "down" && key == "arrowdown")
            || (binding.key == "backslash" && key == "\\");
        key_matches
            && event.keystroke.modifiers.control == binding.control
            && event.keystroke.modifiers.shift == binding.shift
            && event.keystroke.modifiers.alt == binding.alt
            && event.keystroke.modifiers.function == binding.function
            && !event.keystroke.modifiers.platform
    }

    pub fn preview_bridge_script(&self) -> String {
        let bindings = self
            .bindings
            .iter()
            .map(|(action, binding)| {
                format!(
                    "{{action:{:?},key:{:?},ctrl:{},shift:{},alt:{},function:{}}}",
                    action_name(*action),
                    binding.key,
                    binding.control,
                    binding.shift,
                    binding.alt,
                    binding.function
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let mut script = String::from("(()=>{");
        script.push_str("const b=[");
        script.push_str(&bindings);
        script.push_str("];const k=e=>e.key.toLowerCase()===");
        script.push_str("'arrowleft'?'left':e.key.toLowerCase()==='arrowright'?");
        script.push_str("'right':e.key.toLowerCase()==='arrowup'?'up':");
        script.push_str("e.key.toLowerCase()==='arrowdown'?'down':e.key.toLowerCase();");
        script.push_str("document.addEventListener('keydown',e=>{");
        script.push_str("const key=k(e);const ctrl=e.ctrlKey||e.metaKey;");
        script.push_str("const hit=b.find(x=>x.key===key&&x.ctrl===ctrl&&");
        script.push_str("x.shift===e.shiftKey&&x.alt===e.altKey&&");
        script.push_str("x.function===e.getModifierState('Fn'));");
        script.push_str("if(!hit&&key!=='escape')return;e.preventDefault();");
        script.push_str("e.stopPropagation();window.ipc.postMessage(JSON.stringify({");
        script.push_str("v:1,id:String(Date.now()),type:'shortcut',payload:{");
        script.push_str("action:hit?.action||'focus',key:e.key,alt:e.altKey,");
        script.push_str("ctrl:ctrl,shift:e.shiftKey,meta:e.metaKey}}));},true);");
        script.push_str("document.addEventListener('click',e=>{const a=e.target.closest?.('a');");
        script.push_str(
            "if(!a)return;const u=a.href||'';if(!/^(https?:|mailto:|file:|ssh:)/i.test(u))return;",
        );
        script.push_str(
            "e.preventDefault();e.stopPropagation();window.ipc.postMessage(JSON.stringify({",
        );
        script.push_str("v:1,id:String(Date.now()),type:'openLink',payload:{url:u}}));},true);");
        script.push_str("})()");
        script
    }

    fn set(&mut self, action: Action, binding: Binding) {
        if let Some((_, current)) = self
            .bindings
            .iter_mut()
            .find(|(candidate, _)| *candidate == action)
        {
            *current = binding;
        }
    }
}

fn action_name(action: Action) -> &'static str {
    match action {
        Action::ToggleCommandPalette => "commandPalette",
        Action::SplitPane => "newTerminal",
        Action::ClosePane => "closeTerminal",
        Action::ResizeLeft => "resizeLeft",
        Action::ResizeRight => "resizeRight",
        Action::ResizeUp => "resizeUp",
        Action::ResizeDown => "resizeDown",
        Action::SearchTerminal => "sessionHistory",
        Action::CopySelection => "copyTerminalSelection",
    }
}

impl Binding {
    fn parse(value: &str) -> Option<Self> {
        let mut binding = Self {
            key: String::new(),
            control: false,
            shift: false,
            alt: false,
            function: false,
        };
        for part in value
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            match part.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => binding.control = true,
                "shift" => binding.shift = true,
                "alt" | "option" => binding.alt = true,
                "fn" | "function" => binding.function = true,
                key if binding.key.is_empty() => binding.key = normalize_key(key),
                _ => return None,
            }
        }
        (!binding.key.is_empty()).then_some(binding)
    }
}

fn binding(key: &str, control: bool, shift: bool, alt: bool, function: bool) -> Binding {
    Binding {
        key: key.to_owned(),
        control,
        shift,
        alt,
        function,
    }
}

fn normalize_key(key: &str) -> String {
    match key.to_ascii_lowercase().as_str() {
        "arrowleft" => "left".to_owned(),
        "arrowright" => "right".to_owned(),
        "arrowup" => "up".to_owned(),
        "arrowdown" => "down".to_owned(),
        "backslash" => "backslash".to_owned(),
        other => other.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(key: &str, modifiers: gpui::Modifiers) -> KeyDownEvent {
        KeyDownEvent {
            keystroke: gpui::Keystroke {
                modifiers,
                key: key.to_owned(),
                key_char: None,
            },
            is_held: false,
            prefer_character_input: false,
        }
    }

    #[test]
    fn reads_shared_tauri_shortcuts_and_normalizes_keys() {
        let value = serde_json::json!({
            "commandPalette": "Ctrl+Shift+P",
            "newTerminal": "Ctrl+Shift+\\",
            "closeTerminal": "Ctrl+W",
            "sessionHistory": "Ctrl+K",
            "copyTerminalSelection": "Ctrl+Shift+C"
        });
        let keymap = Keymap::from_settings(Some(&value));
        assert!(keymap.matches(
            &event(
                "P",
                gpui::Modifiers {
                    control: true,
                    shift: true,
                    ..Default::default()
                }
            ),
            Action::ToggleCommandPalette
        ));
        assert!(keymap.matches(
            &event(
                "\\",
                gpui::Modifiers {
                    control: true,
                    shift: true,
                    ..Default::default()
                }
            ),
            Action::SplitPane
        ));
        assert!(keymap.matches(
            &event(
                "C",
                gpui::Modifiers {
                    control: true,
                    shift: true,
                    ..Default::default()
                }
            ),
            Action::CopySelection
        ));
    }

    #[test]
    fn invalid_binding_keeps_safe_default() {
        let value = serde_json::json!({ "commandPalette": "Ctrl+Unknown+P" });
        let keymap = Keymap::from_settings(Some(&value));
        assert!(keymap.matches(
            &event(
                "P",
                gpui::Modifiers {
                    control: true,
                    ..Default::default()
                }
            ),
            Action::ToggleCommandPalette
        ));
    }

    #[test]
    fn preview_bridge_script_contains_current_shortcut_actions() {
        let script = Keymap::default().preview_bridge_script();
        assert!(script.contains("commandPalette"));
        assert!(script.contains("newTerminal"));
        assert!(script.contains("window.ipc.postMessage"));
        assert!(script.contains("key!=='escape'"));
        assert!(script.contains("type:'openLink'"));
    }
}
