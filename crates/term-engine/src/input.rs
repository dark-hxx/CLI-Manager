//! Keyboard bytes for a PTY. GPUI maps its platform key event to this small type.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Modifiers {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

impl Modifiers {
    pub const NONE: Self = Self {
        ctrl: false,
        alt: false,
        shift: false,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Enter,
    Tab,
    Backspace,
    Escape,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    Delete,
    Function(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputMode {
    pub application_cursor: bool,
    pub kitty_keyboard: bool,
    pub bracketed_paste: bool,
}

impl Default for InputMode {
    fn default() -> Self {
        Self {
            application_cursor: false,
            kitty_keyboard: false,
            bracketed_paste: false,
        }
    }
}

pub fn encode_paste(data: &[u8], mode: InputMode) -> Vec<u8> {
    if !mode.bracketed_paste {
        return data.to_vec();
    }
    let mut encoded = Vec::with_capacity(data.len() + 12);
    encoded.extend_from_slice(b"\x1b[200~");
    encoded.extend_from_slice(data);
    encoded.extend_from_slice(b"\x1b[201~");
    encoded
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEventKind {
    Press,
    Release,
    Motion,
    ScrollUp,
    ScrollDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseEvent {
    pub button: MouseButton,
    pub kind: MouseEventKind,
    pub column: u16,
    pub row: u16,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MouseInputMode {
    pub click: bool,
    pub drag: bool,
    pub motion: bool,
    pub sgr: bool,
}

pub fn encode_mouse(event: MouseEvent, mode: MouseInputMode) -> Option<Vec<u8>> {
    let reporting = match event.kind {
        MouseEventKind::Press | MouseEventKind::Release => mode.click,
        MouseEventKind::Motion => mode.motion || mode.drag,
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            mode.click || mode.drag || mode.motion
        }
    };
    if !reporting || event.column == 0 || event.row == 0 {
        return None;
    }
    let base = match event.kind {
        MouseEventKind::ScrollUp => 64,
        MouseEventKind::ScrollDown => 65,
        _ => match event.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            MouseButton::None => 3,
        },
    };
    let mut code =
        base + u8::from(event.shift) * 4 + u8::from(event.alt) * 8 + u8::from(event.ctrl) * 16;
    if event.kind == MouseEventKind::Motion {
        code += 32;
    }
    let x = event.column;
    let y = event.row;
    if mode.sgr {
        let suffix = if event.kind == MouseEventKind::Release {
            'm'
        } else {
            'M'
        };
        Some(format!("\x1b[<{};{};{}{}", code, x, y, suffix).into_bytes())
    } else {
        let suffix = if event.kind == MouseEventKind::Release {
            3
        } else {
            code
        };
        if x > 223 || y > 223 || suffix > 223 {
            return None;
        }
        Some(vec![
            0x1b,
            b'[',
            b'M',
            32 + suffix,
            32 + x as u8,
            32 + y as u8,
        ])
    }
}

pub fn encode(key: Key, modifiers: Modifiers, mode: InputMode) -> Vec<u8> {
    let mut bytes = match key {
        Key::Char(ch) if modifiers.ctrl => {
            ctrl(ch).map_or_else(|| ch.to_string().into_bytes(), |v| vec![v])
        }
        Key::Char(ch) => ch.to_string().into_bytes(),
        Key::Enter => b"\r".to_vec(),
        Key::Tab => b"\t".to_vec(),
        Key::Backspace => vec![0x7f],
        Key::Escape => vec![0x1b],
        Key::Up => csi_cursor('A', modifiers, mode),
        Key::Down => csi_cursor('B', modifiers, mode),
        Key::Right => csi_cursor('C', modifiers, mode),
        Key::Left => csi_cursor('D', modifiers, mode),
        Key::Home => csi_tilde_or_cursor("H", 1, modifiers, mode),
        Key::End => csi_tilde_or_cursor("F", 4, modifiers, mode),
        Key::PageUp => csi_tilde_or_cursor("~", 5, modifiers, mode),
        Key::PageDown => csi_tilde_or_cursor("~", 6, modifiers, mode),
        Key::Insert => csi_tilde_or_cursor("~", 2, modifiers, mode),
        Key::Delete => csi_tilde_or_cursor("~", 3, modifiers, mode),
        Key::Function(number) => function_key(number, modifiers, mode),
    };
    if modifiers.alt && !modifiers.ctrl && !matches!(key, Key::Escape) {
        bytes.insert(0, 0x1b);
    }
    bytes
}

fn ctrl(ch: char) -> Option<u8> {
    let upper = ch.to_ascii_uppercase();
    match upper {
        '@'..='_' => Some((upper as u8) & 0x1f),
        '?' => Some(0x7f),
        _ => None,
    }
}

fn csi_cursor(final_byte: char, modifiers: Modifiers, mode: InputMode) -> Vec<u8> {
    if mode.kitty_keyboard {
        return kitty(final_byte, modifiers);
    }
    let prefix = if mode.application_cursor {
        "\x1bO"
    } else {
        "\x1b["
    };
    if modifiers.shift || modifiers.alt || modifiers.ctrl {
        return format!("\x1b[1;{}{}", modifier_value(modifiers), final_byte).into_bytes();
    }
    format!("{prefix}{final_byte}").into_bytes()
}

fn csi_tilde_or_cursor(
    final_part: &str,
    number: u8,
    modifiers: Modifiers,
    mode: InputMode,
) -> Vec<u8> {
    if modifiers.shift || modifiers.alt || modifiers.ctrl || mode.kitty_keyboard {
        return format!(
            "\x1b[{};{}{}",
            number,
            modifier_value(modifiers),
            final_part
        )
        .into_bytes();
    }
    if final_part == "~" {
        format!("\x1b[{}~", number).into_bytes()
    } else if mode.application_cursor {
        format!("\x1bO{final_part}").into_bytes()
    } else {
        format!("\x1b[{final_part}").into_bytes()
    }
}

fn function_key(number: u8, modifiers: Modifiers, mode: InputMode) -> Vec<u8> {
    if (1..=4).contains(&number)
        && !modifiers.shift
        && !modifiers.alt
        && !modifiers.ctrl
        && !mode.kitty_keyboard
    {
        return vec![0x1b, b'O', b'P' + number - 1];
    }
    let code = match number {
        1..=4 => number + 9,
        5..=12 => number - 4,
        _ => return Vec::new(),
    };
    csi_tilde_or_cursor("~", code, modifiers, mode)
}

fn kitty(final_byte: char, modifiers: Modifiers) -> Vec<u8> {
    format!("\x1b[1;{}{}", modifier_value(modifiers), final_byte).into_bytes()
}

fn modifier_value(modifiers: Modifiers) -> u8 {
    1 + u8::from(modifiers.shift) + 2 * u8::from(modifiers.alt) + 4 * u8::from(modifiers.ctrl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_text_control_alt_and_application_cursor() {
        assert_eq!(
            encode(
                Key::Char('c'),
                Modifiers {
                    ctrl: true,
                    ..Modifiers::NONE
                },
                InputMode::default()
            ),
            b"\x03"
        );
        assert_eq!(
            encode(
                Key::Char('x'),
                Modifiers {
                    alt: true,
                    ..Modifiers::NONE
                },
                InputMode::default()
            ),
            b"\x1bx"
        );
        assert_eq!(
            encode(Key::Up, Modifiers::NONE, InputMode::default()),
            b"\x1b[A"
        );
        assert_eq!(
            encode(
                Key::Up,
                Modifiers::NONE,
                InputMode {
                    application_cursor: true,
                    kitty_keyboard: false,
                    ..InputMode::default()
                }
            ),
            b"\x1bOA"
        );
    }

    #[test]
    fn encodes_modified_and_kitty_navigation() {
        let modified = Modifiers {
            ctrl: true,
            alt: false,
            shift: true,
        };
        assert_eq!(
            encode(Key::Right, modified, InputMode::default()),
            b"\x1b[1;6C"
        );
        assert_eq!(
            encode(
                Key::Delete,
                Modifiers::NONE,
                InputMode {
                    kitty_keyboard: true,
                    ..InputMode::default()
                }
            ),
            b"\x1b[3;1~"
        );
        assert_eq!(
            encode(Key::Function(5), Modifiers::NONE, InputMode::default()),
            b"\x1b[1~"
        );
        assert!(encode(Key::Function(0), Modifiers::NONE, InputMode::default()).is_empty());
    }

    #[test]
    fn wraps_paste_only_when_bracketed_paste_is_enabled() {
        assert_eq!(encode_paste(b"a\nb", InputMode::default()), b"a\nb");
        assert_eq!(
            encode_paste(
                b"a\nb",
                InputMode {
                    bracketed_paste: true,
                    ..InputMode::default()
                }
            ),
            b"\x1b[200~a\nb\x1b[201~"
        );
    }

    #[test]
    fn encodes_sgr_and_legacy_mouse_events_with_modifiers() {
        let event = MouseEvent {
            button: MouseButton::Left,
            kind: MouseEventKind::Press,
            column: 4,
            row: 2,
            ctrl: true,
            alt: false,
            shift: true,
        };
        assert_eq!(
            encode_mouse(
                event,
                MouseInputMode {
                    click: true,
                    sgr: true,
                    ..MouseInputMode::default()
                }
            ),
            Some(b"\x1b[<20;4;2M".to_vec())
        );
        assert_eq!(
            encode_mouse(
                MouseEvent {
                    kind: MouseEventKind::Release,
                    ..event
                },
                MouseInputMode {
                    click: true,
                    ..MouseInputMode::default()
                }
            ),
            Some(vec![0x1b, b'[', b'M', 35, 36, 34])
        );
        assert_eq!(
            encode_mouse(
                MouseEvent {
                    button: MouseButton::None,
                    kind: MouseEventKind::ScrollUp,
                    ..event
                },
                MouseInputMode {
                    click: true,
                    sgr: true,
                    ..MouseInputMode::default()
                }
            ),
            Some(b"\x1b[<84;4;2M".to_vec())
        );
    }
}
