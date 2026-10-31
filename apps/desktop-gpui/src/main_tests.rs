use super::*;

#[test]
fn traditional_locale_reuses_messages_with_character_conversion() {
    let messages = load_messages(preferences::InterfaceLanguage::ZhTw);
    assert_eq!(messages["shell.settings.title"], "GPUI 設置");
    assert_eq!(i18n::to_traditional("终端设置已完成"), "終端設置已完成");
}

fn event(key: &str, key_char: Option<&str>, modifiers: gpui::Modifiers) -> gpui::KeyDownEvent {
    gpui::KeyDownEvent {
        keystroke: gpui::Keystroke {
            key: key.into(),
            key_char: key_char.map(str::to_owned),
            modifiers,
        },
        is_held: false,
        prefer_character_input: false,
    }
}

#[test]
fn maps_gpui_keys_to_terminal_bytes() {
    assert_eq!(DesktopShell::terminal_key_bytes(
        &event("c", Some("c"), gpui::Modifiers { control: true, ..Default::default() }),
        InputMode::default(),
    ).unwrap(), b"\x03");
    assert_eq!(DesktopShell::terminal_key_bytes(
        &event("Enter", None, Default::default()), InputMode::default(),
    ).unwrap(), b"\r");
    assert_eq!(DesktopShell::terminal_key_bytes(
        &event("ArrowUp", None, Default::default()), InputMode::default(),
    ).unwrap(), b"\x1b[A");
}

#[test]
fn maps_gpui_mouse_position_and_modifiers_to_sgr_bytes() {
    let bytes = DesktopShell::terminal_mouse_bytes(
        Point { x: px(24.), y: px(16.) },
        Some(MouseButton::Left),
        MouseEventKind::Press,
        gpui::Modifiers { control: true, ..Default::default() },
        MouseInputMode { click: true, sgr: true, ..MouseInputMode::default() },
        (8.0, 16.0),
        Point { x: px(0.), y: px(0.) },
    );
    assert_eq!(bytes, Some(b"\x1b[<16;4;2M".to_vec()));
    let offset_bytes = DesktopShell::terminal_mouse_bytes(
        Point { x: px(32.), y: px(32.) },
        Some(MouseButton::Left),
        MouseEventKind::Press,
        gpui::Modifiers { control: true, ..Default::default() },
        MouseInputMode { click: true, sgr: true, ..MouseInputMode::default() },
        (8.0, 16.0),
        Point { x: px(16.), y: px(16.) },
    );
    assert_eq!(offset_bytes, Some(b"\x1b[<16;3;2M".to_vec()));
}

#[test]
fn terminal_grid_size_has_safe_minimum_and_tracks_window() {
    assert_eq!(terminal_grid_size(100., 100., 8., 16.), (2, 1));
    assert_eq!(terminal_grid_size(1038., 718., 8., 16.), (100, 40));
    assert_eq!(terminal_grid_size(1038., 718., 10., 20.), (80, 32));
}
