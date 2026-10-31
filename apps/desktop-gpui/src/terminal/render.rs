use super::row_cache::{PreparedText, RowDecorations, RowPreparationCache};
use cli_manager_term_engine::search::TextSpan;
use cli_manager_term_engine::{
    Cell, CellFlags, Color, Colors, CursorShape, FrameSnapshot, NamedColor, Rgb,
};
use gpui::{
    div, prelude::*, px, rgba, FontStyle, FontWeight, Hsla, StrikethroughStyle, StyledText,
    TextRun, UnderlineStyle,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RunStyle {
    foreground: Rgb,
    background: Rgb,
    bold: bool,
    italic: bool,
    underline: bool,
    strikethrough: bool,
    cursor: bool,
    search: bool,
}

pub fn styled_lines(
    rows: &[Vec<Cell>],
    frame: &FrameSnapshot,
    selection: Option<((usize, usize), (usize, usize))>,
    urls: &[TextSpan],
    search: &[TextSpan],
    settings: &cli_manager_core_prefs::terminal::TerminalPreferences,
    cell_size: (f32, f32),
    cache: &mut RowPreparationCache,
) -> Vec<gpui::AnyElement> {
    prepared_lines(
        rows,
        frame,
        selection,
        urls,
        search,
        settings,
        cell_size,
        Some(cache),
    )
    .into_iter()
    .map(|line| {
        div()
            .relative()
            .h(px(cell_size.1))
            .text_size(px(settings.font_size as f32))
            .line_height(px(cell_size.1))
            .child(StyledText::new(line.text).with_runs(line.runs))
            .children(line.cursor.map(|(left, top, width, height)| {
                div()
                    .absolute()
                    .left(px(left))
                    .top(px(top))
                    .w(px(width))
                    .h(px(height))
                    .bg(hsla(resolve_color(
                        Color::Named(NamedColor::Foreground),
                        &frame.colors,
                        false,
                    )))
            }))
            .into_any_element()
    })
    .collect()
}

pub(super) struct PreparedLine {
    pub(super) text: gpui::SharedString,
    pub(super) runs: Vec<TextRun>,
    pub(super) cursor: Option<(f32, f32, f32, f32)>,
}

pub(super) fn prepared_lines(
    rows: &[Vec<Cell>],
    frame: &FrameSnapshot,
    selection: Option<((usize, usize), (usize, usize))>,
    urls: &[TextSpan],
    search: &[TextSpan],
    settings: &cli_manager_core_prefs::terminal::TerminalPreferences,
    cell_size: (f32, f32),
    mut cache: Option<&mut RowPreparationCache>,
) -> Vec<PreparedLine> {
    let descriptor = super::appearance::font_descriptor(settings);
    let context = cache
        .as_mut()
        .map(|cache| cache.context(&frame.colors, descriptor.clone()));
    rows.iter()
        .take(frame.size.rows())
        .enumerate()
        .map(|(row, cells)| {
            let prepare = || {
                let mut text = String::new();
                let mut runs = Vec::new();
                let mut current: Option<(RunStyle, usize)> = None;
                for (column, cell) in cells.iter().enumerate() {
                    if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                        continue;
                    }
                    let style = style_for(
                        cell,
                        &frame.colors,
                        matches!(
                            frame.cursor.shape,
                            CursorShape::Block | CursorShape::HollowBlock
                        ) && frame.cursor.point.line.0 >= 0
                            && frame.cursor.point.line.0 as usize == row
                            && frame.cursor.point.column.0 as usize == column,
                        selection_contains(selection, row, column),
                        span_contains(urls, row, column),
                        span_contains(search, row, column),
                    );
                    let start = text.len();
                    text.push(cell.c);
                    if let Some(chars) = cell.zerowidth() {
                        text.extend(chars.iter().copied());
                    }
                    match current {
                        Some((previous, run_start)) if previous == style => {
                            current = Some((previous, run_start));
                        }
                        Some((previous, run_start)) => {
                            runs.push(text_run(start - run_start, previous, &descriptor));
                            current = Some((style, start));
                        }
                        None => current = Some((style, start)),
                    }
                }
                if let Some((style, run_start)) = current {
                    runs.push(text_run(text.len() - run_start, style, &descriptor));
                }
                PreparedText {
                    text: text.into(),
                    runs,
                }
            };
            let text = match (&mut cache, &context) {
                (Some(cache), Some(context)) => {
                    let decorations =
                        row_decorations(row, cells.len(), frame, selection, urls, search);
                    cache.get_or_prepare(cells, context, decorations, prepare)
                }
                _ => prepare(),
            };
            PreparedLine {
                text: text.text,
                runs: text.runs,
                cursor: cursor_rectangle(frame, row, cell_size),
            }
        })
        .collect()
}

fn row_decorations(
    row: usize,
    columns: usize,
    frame: &FrameSnapshot,
    selection: Option<((usize, usize), (usize, usize))>,
    urls: &[TextSpan],
    search: &[TextSpan],
) -> RowDecorations {
    let ranges = |spans: &[TextSpan]| {
        spans
            .iter()
            .filter(|span| span.row == row)
            .map(|span| span.start_column.min(columns)..span.end_column.min(columns))
            .collect()
    };
    let selection = selection.and_then(|(start, end)| {
        let (start, end) = if start <= end {
            (start, end)
        } else {
            (end, start)
        };
        if row < start.0 || row > end.0 {
            return None;
        }
        let left = if row == start.0 {
            start.1.min(columns)
        } else {
            0
        };
        let right = if row == end.0 {
            end.1.saturating_add(1).min(columns)
        } else {
            columns
        };
        Some(left..right)
    });
    RowDecorations {
        cursor: (matches!(
            frame.cursor.shape,
            CursorShape::Block | CursorShape::HollowBlock
        ) && frame.cursor.point.line.0 == row as i32)
            .then_some(frame.cursor.point.column.0),
        selection,
        urls: ranges(urls),
        search: ranges(search),
    }
}

fn style_for(
    cell: &Cell,
    colors: &Colors,
    cursor: bool,
    selected: bool,
    url: bool,
    search: bool,
) -> RunStyle {
    let foreground = resolve_color(cell.fg, colors, false);
    let background = resolve_color(cell.bg, colors, true);
    let (foreground, background) = if selected {
        (
            Rgb {
                r: 0x12,
                g: 0x16,
                b: 0x1d,
            },
            Rgb {
                r: 0x70,
                g: 0x9d,
                b: 0xd3,
            },
        )
    } else if cursor {
        (background, foreground)
    } else if search {
        (
            Rgb {
                r: 0x18,
                g: 0x1a,
                b: 0x1f,
            },
            Rgb {
                r: 0xf2,
                g: 0xc9,
                b: 0x4c,
            },
        )
    } else if url {
        (
            Rgb {
                r: 0x5d,
                g: 0xa9,
                b: 0xff,
            },
            background,
        )
    } else {
        (foreground, background)
    };
    RunStyle {
        foreground,
        background,
        bold: cell.flags.contains(CellFlags::BOLD),
        italic: cell.flags.contains(CellFlags::ITALIC),
        underline: url || cell.flags.intersects(CellFlags::ALL_UNDERLINES),
        strikethrough: cell.flags.contains(CellFlags::STRIKEOUT),
        cursor,
        search,
    }
}

fn cursor_rectangle(
    frame: &FrameSnapshot,
    row: usize,
    cell: (f32, f32),
) -> Option<(f32, f32, f32, f32)> {
    if frame.display_offset != 0
        || frame.cursor.point.line.0 != row as i32
        || frame.cursor.point.column.0 >= frame.size.columns()
    {
        return None;
    }
    let left = frame.cursor.point.column.0 as f32 * cell.0;
    match frame.cursor.shape {
        CursorShape::Beam => Some((left, 0., 2f32.min(cell.0), cell.1)),
        CursorShape::Underline => Some((left, (cell.1 - 2.).max(0.), cell.0, 2f32.min(cell.1))),
        _ => None,
    }
}

#[cfg(test)]
mod cursor_tests {
    use super::*;
    use cli_manager_term_engine::{Engine, EventProxy, Size};

    #[test]
    fn cached_rows_match_uncached_across_decorations_palette_and_geometry_changes() {
        let mut cache = RowPreparationCache::default();
        let mut engine =
            Engine::new(Size::new(24, 3).unwrap(), 100, EventProxy::new(|_| {})).unwrap();
        engine.advance("\x1b[31m中文 e\u{301}\x1b[0m hello\r\nhttps://a.test".as_bytes());
        let mut settings = cli_manager_core_prefs::terminal::TerminalPreferences::default();
        let frame = engine.snapshot();
        let mut rows = vec![Vec::new(); 3];
        for (row, cells) in &frame.rows {
            rows[*row] = cells.clone();
        }
        let urls = cli_manager_term_engine::search::find_urls(&rows);
        let matches = cli_manager_term_engine::search::find_matches(&rows, "hello");
        for step in 0..12 {
            if step == 4 {
                settings.font_family = "Other Mono, Consolas".into();
            }
            if step == 6 {
                settings.font_size = 20.;
                settings.line_height = 1.4;
            }
            engine
                .configure(
                    100,
                    if step % 2 == 0 {
                        CursorShape::Block
                    } else {
                        CursorShape::Beam
                    },
                )
                .unwrap();
            if step == 8 {
                engine.advance(b"\x1b]10;#123456\x07");
            }
            let frame = engine.snapshot();
            let selection = (step % 3 == 0).then_some(((1, 6), (0, 1)));
            let search = if step % 2 == 0 { &matches[..] } else { &[] };
            let cell = if step >= 6 { (11., 28.) } else { (8., 16.) };
            let cached = prepared_lines(
                &rows,
                &frame,
                selection,
                &urls,
                search,
                &settings,
                cell,
                Some(&mut cache),
            );
            let expected = prepared_lines(
                &rows, &frame, selection, &urls, search, &settings, cell, None,
            );
            for (cached, expected) in cached.iter().zip(&expected) {
                assert_eq!(cached.text, expected.text);
                assert_eq!(cached.runs, expected.runs);
                assert_eq!(cached.cursor, expected.cursor);
            }
        }
        assert!(cache.stats().hits > 0);
        assert!(cache.stats().misses > 3);
    }

    #[test]
    fn bar_and_underline_have_distinct_geometry_and_hidden_cursor_has_none() {
        let mut engine =
            Engine::new(Size::new(10, 3).unwrap(), 100, EventProxy::new(|_| {})).unwrap();
        engine.configure(100, CursorShape::Beam).unwrap();
        engine.advance(b"abc");
        assert_eq!(
            cursor_rectangle(&engine.snapshot(), 0, (8., 18.)),
            Some((24., 0., 2., 18.))
        );
        engine.configure(100, CursorShape::Underline).unwrap();
        assert_eq!(
            cursor_rectangle(&engine.snapshot(), 0, (8., 18.)),
            Some((24., 16., 8., 2.))
        );
        engine.advance(b"\x1b[?25l");
        assert!(cursor_rectangle(&engine.snapshot(), 0, (8., 18.)).is_none());
    }

    #[test]
    fn row_cache_matches_fresh_output_after_alternate_screen_resize_and_scroll() {
        let mut cache = RowPreparationCache::default();
        let mut engine =
            Engine::new(Size::new(12, 3).unwrap(), 100, EventProxy::new(|_| {})).unwrap();
        let settings = cli_manager_core_prefs::terminal::TerminalPreferences::default();
        let mut rows = vec![Vec::new(); 3];
        for sequence in [
            "line one\r\nline two\r\nline three\r\nfour",
            "\x1b[?1049h中 e\u{301}",
            "\x1b[?1049l",
            "\x1b[?25l",
            "\x1b[2Jnew",
            "\x1b[?25h",
        ] {
            engine.advance(sequence.as_bytes());
            if sequence == "\x1b[?25l" {
                engine.resize(Size::new(8, 4).unwrap());
            }
            let frame = engine.snapshot();
            if frame.full || rows.len() != frame.size.rows() {
                rows = vec![Vec::new(); frame.size.rows()];
            }
            for (row, cells) in &frame.rows {
                rows[*row] = cells.clone();
            }
            let cached = prepared_lines(
                &rows,
                &frame,
                None,
                &[],
                &[],
                &settings,
                (8., 16.),
                Some(&mut cache),
            );
            let fresh = prepared_lines(&rows, &frame, None, &[], &[], &settings, (8., 16.), None);
            assert_eq!(cached.len(), fresh.len());
            for (cached, fresh) in cached.iter().zip(&fresh) {
                assert_eq!(cached.text, fresh.text);
                assert_eq!(cached.runs, fresh.runs);
                assert_eq!(cached.cursor, fresh.cursor);
            }
        }
    }
}

fn span_contains(spans: &[TextSpan], row: usize, column: usize) -> bool {
    spans
        .iter()
        .any(|span| span.row == row && column >= span.start_column && column < span.end_column)
}

fn selection_contains(
    selection: Option<((usize, usize), (usize, usize))>,
    row: usize,
    column: usize,
) -> bool {
    let Some((start, end)) = selection else {
        return false;
    };
    let (start, end) = if start <= end {
        (start, end)
    } else {
        (end, start)
    };
    (row, column) >= start && (row, column) <= end
}

fn text_run(len: usize, style: RunStyle, descriptor: &gpui::Font) -> TextRun {
    let foreground = hsla(style.foreground);
    let mut font = descriptor.clone();
    font.weight = if style.bold {
        FontWeight::BOLD
    } else {
        FontWeight::NORMAL
    };
    font.style = if style.italic {
        FontStyle::Italic
    } else {
        FontStyle::Normal
    };
    TextRun {
        len,
        font,
        color: foreground,
        background_color: Some(hsla(style.background)),
        underline: style.underline.then_some(UnderlineStyle {
            thickness: px(1.0),
            color: Some(foreground),
            wavy: false,
        }),
        strikethrough: style.strikethrough.then_some(StrikethroughStyle {
            thickness: px(1.0),
            color: Some(foreground),
        }),
    }
}

fn hsla(color: Rgb) -> Hsla {
    Hsla::from(rgba(
        ((color.r as u32) << 24) | ((color.g as u32) << 16) | ((color.b as u32) << 8) | 0xff,
    ))
}

fn resolve_color(color: Color, colors: &Colors, background: bool) -> Rgb {
    match color {
        Color::Spec(rgb) => rgb,
        Color::Indexed(index) => colors[index as usize].unwrap_or_else(|| indexed_color(index)),
        Color::Named(named) => colors[named].unwrap_or_else(|| named_color(named, background)),
    }
}

fn named_color(color: NamedColor, background: bool) -> Rgb {
    let value = match color {
        NamedColor::Black => 0x000000,
        NamedColor::Red => 0xcd0000,
        NamedColor::Green => 0x00cd00,
        NamedColor::Yellow => 0xcdcd00,
        NamedColor::Blue => 0x0000ee,
        NamedColor::Magenta => 0xcd00cd,
        NamedColor::Cyan => 0x00cdcd,
        NamedColor::White => 0xe5e5e5,
        NamedColor::BrightBlack => 0x7f7f7f,
        NamedColor::BrightRed => 0xff0000,
        NamedColor::BrightGreen => 0x00ff00,
        NamedColor::BrightYellow => 0xffff00,
        NamedColor::BrightBlue => 0x5c5cff,
        NamedColor::BrightMagenta => 0xff00ff,
        NamedColor::BrightCyan => 0x00ffff,
        NamedColor::BrightWhite => 0xffffff,
        NamedColor::Foreground | NamedColor::BrightForeground => 0xe8edf4,
        NamedColor::Background => 0x12161d,
        _ => {
            if background {
                0x12161d
            } else {
                0xe8edf4
            }
        }
    };
    Rgb {
        r: (value >> 16) as u8,
        g: (value >> 8) as u8,
        b: value as u8,
    }
}

fn indexed_color(index: u8) -> Rgb {
    match index {
        0..=15 => {
            let bright = index >= 8;
            let base = match index % 8 {
                0 => (0, 0, 0),
                1 => (205, 0, 0),
                2 => (0, 205, 0),
                3 => (205, 205, 0),
                4 => (0, 0, 238),
                5 => (205, 0, 205),
                6 => (0, 205, 205),
                _ => (229, 229, 229),
            };
            let brighten = |channel: u8| if channel == 0 { 127 } else { 255 };
            Rgb {
                r: if bright { brighten(base.0) } else { base.0 },
                g: if bright { brighten(base.1) } else { base.1 },
                b: if bright { brighten(base.2) } else { base.2 },
            }
        }
        16..=231 => {
            let value = index - 16;
            let level = |part: u8| if part == 0 { 0 } else { 55 + part * 40 };
            Rgb {
                r: level(value / 36),
                g: level((value / 6) % 6),
                b: level(value % 6),
            }
        }
        232..=255 => {
            let value = 8 + (index - 232) * 10;
            Rgb {
                r: value,
                g: value,
                b: value,
            }
        }
    }
}
