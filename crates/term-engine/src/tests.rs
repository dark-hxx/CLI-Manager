use super::*;
use alacritty_terminal::{
    term::cell::Flags,
    vte::ansi::{Color, NamedColor},
};
use std::sync::Mutex;

fn engine() -> Engine {
    Engine::new(Size::new(12, 3).unwrap(), 100, EventProxy::new(|_| {})).unwrap()
}

#[test]
fn configuration_updates_history_and_cursor_without_resetting_parser_or_content() {
    let mut model = engine();
    model.advance(b"keep\x1b[3");
    assert!(model.configure(2, CursorShape::Beam).unwrap());
    model.advance(b"1m red");
    let frame = model.snapshot();
    assert_eq!(line(&frame, 0), "keep red");
    assert_eq!(frame.rows[0].1[5].fg, Color::Named(NamedColor::Red));
    assert_eq!(frame.cursor.shape, CursorShape::Beam);
    assert!(!model.configure(2, CursorShape::Beam).unwrap());
    assert_eq!(
        model.configure(100_001, CursorShape::Block),
        Err("scrollback limit exceeded")
    );
    for _ in 0..20 {
        model.advance(b"\r\nnext");
    }
    assert_eq!(model.term.grid().history_size(), 2);
    model.reset(Size::new(12, 3).unwrap());
    assert_eq!(model.snapshot().cursor.shape, CursorShape::Beam);
}

#[test]
fn configuration_respects_application_cursor_overrides_and_inactive_history() {
    let mut model = engine();
    for _ in 0..15 {
        model.advance(b"row\r\n");
    }
    model.advance(b"\x1b[4 q");
    model.configure(10, CursorShape::Beam).unwrap();
    assert_eq!(model.snapshot().cursor.shape, CursorShape::Underline);
    model.advance(b"\x1b[0 q");
    assert_eq!(model.snapshot().cursor.shape, CursorShape::Beam);
    model.advance(b"\x1b[?1049hALT");
    model.configure(1, CursorShape::Block).unwrap();
    model.advance(b"\x1b[?1049l");
    assert_eq!(model.term.grid().history_size(), 1);
    assert_eq!(model.snapshot().cursor.shape, CursorShape::Block);
}

fn line(snapshot: &FrameSnapshot, row: usize) -> String {
    snapshot
        .rows
        .iter()
        .find(|(y, _)| *y == row)
        .unwrap()
        .1
        .iter()
        .filter(|c| !c.flags.contains(Flags::WIDE_CHAR_SPACER))
        .map(|c| c.c)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

#[test]
fn fragmented_utf8_sgr_and_combining_keep_cell_attributes() {
    let mut model = engine();
    for byte in "\x1b[31;1m中e\u{301}".as_bytes() {
        model.advance(&[*byte]);
    }
    let frame = model.snapshot();
    let cells = &frame.rows[0].1;
    assert_eq!(cells[0].c, '中');
    assert!(cells[0].flags.contains(Flags::WIDE_CHAR | Flags::BOLD));
    assert!(cells[1].flags.contains(Flags::WIDE_CHAR_SPACER));
    assert_eq!(cells[0].fg, Color::Named(NamedColor::Red));
    assert_eq!(cells[2].c, 'e');
    assert_eq!(cells[2].zerowidth(), Some(&['\u{301}'][..]));
}

#[test]
fn alternate_screen_restores_primary_and_resize_invalidates_rows() {
    let mut model = engine();
    model.advance(b"primary\x1b[?1049hother");
    assert!(model.mode().contains(TermMode::ALT_SCREEN));
    assert!(line(&model.snapshot(), 0).contains("other"));
    model.advance(b"\x1b[?1049l");
    assert_eq!(line(&model.snapshot(), 0), "primary");
    model.resize(Size::new(20, 4).unwrap());
    let frame = model.snapshot();
    assert!(frame.full);
    assert_eq!(frame.rows.len(), 4);
    assert_eq!(frame.rows[0].1.len(), 20);
}

#[test]
fn forwards_title_bell_and_device_status_response() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let output = events.clone();
    let mut model = Engine::new(
        Size::new(10, 3).unwrap(),
        0,
        EventProxy::new(move |event| output.lock().unwrap().push(event)),
    )
    .unwrap();
    model.advance(b"\x1b]2;hello\x07\x07\x1b[2;3H\x1b[6n");
    let events = events.lock().unwrap();
    assert!(events
        .iter()
        .any(|e| matches!(e, Event::Title(s) if s == "hello")));
    assert!(events.iter().any(|e| matches!(e, Event::Bell)));
    assert!(events
        .iter()
        .any(|e| matches!(e, Event::PtyWrite(s) if s == "\x1b[2;3R")));
}

#[test]
fn reset_clears_partial_parser_and_retains_size_limits() {
    let mut model = engine();
    model.advance(b"old\x1b[31;");
    model.reset(Size::new(10, 2).unwrap());
    model.advance(b"new");
    let frame = model.snapshot();
    assert!(frame.full);
    assert_eq!(line(&frame, 0), "new");
    assert_eq!(frame.rows[0].1[0].fg, Color::Named(NamedColor::Foreground));
    assert!(Size::new(1, 3).is_err());
    assert!(Size::new(10, 0).is_err());
    assert!(Size::new(4096, 4096).is_err());
    assert!(Engine::new(Size::new(80, 24).unwrap(), 100_001, EventProxy::new(|_| {})).is_err());
}

#[test]
fn snapshots_are_owned_and_damage_is_consumed() {
    let mut model = engine();
    model.advance(b"a");
    let first = model.snapshot();
    let clean = model.snapshot();
    // Cursor rows can remain damaged; untouched rows must not be copied again.
    assert!(!clean.full);
    assert!(clean.rows.len() < 3);
    model.advance(b"\rb");
    assert_eq!(line(&first, 0), "a");
    assert_eq!(line(&model.snapshot(), 0), "b");
}

#[test]
fn scrollback_snapshot_uses_viewport_offset_and_preserves_hyperlinks() {
    let mut model = engine();
    model.advance(b"one\r\ntwo\r\nthree\r\nfour");
    model.scroll(1);
    let frame = model.snapshot();
    assert_eq!(frame.display_offset, 1);
    assert_eq!(line(&frame, 0), "one");
    model.reset(Size::new(12, 3).unwrap());
    model.advance(b"\x1b]8;id=test;https://example.com\x1b\\link\x1b]8;;\x1b\\");
    let frame = model.snapshot();
    assert_eq!(
        frame.rows[0].1[0].hyperlink().unwrap().uri(),
        "https://example.com"
    );
}

#[test]
fn ansi_checkpoint_round_trips_visible_cells_attributes_and_cursor() {
    let mut source = engine();
    source.advance(
        b"\x1b[1;31;44mhello\x1b[0m\x1b]8;id=docs;https://example.com\x1b\\link\x1b]8;;\x1b\\",
    );
    let checkpoint = source.serialize_to_ansi();
    assert!(checkpoint.starts_with(b"\x1b[2J\x1b[H"));

    let mut restored = engine();
    restored.advance(&checkpoint);
    let source_frame = source.snapshot();
    let restored_frame = restored.snapshot();
    assert_eq!(line(&source_frame, 0), line(&restored_frame, 0));
    assert_eq!(source_frame.rows[0].1[0].fg, restored_frame.rows[0].1[0].fg);
    assert_eq!(source_frame.rows[0].1[0].bg, restored_frame.rows[0].1[0].bg);
    assert!(restored_frame.rows[0].1[5].hyperlink().is_some());
    assert_eq!(
        restored_frame.rows[0].1[5].hyperlink().unwrap().uri(),
        "https://example.com"
    );
    assert_eq!(source_frame.cursor.point, restored_frame.cursor.point);
}
