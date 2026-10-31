use cli_manager_term_engine::search::TextSpan;
use cli_manager_term_engine::{
    Cell, CellFlags, Color, Colors, CursorShape, FrameSnapshot, NamedColor, Rgb,
};
use gpui::{
    font, px, rgba, FontStyle, FontWeight, Hsla, StrikethroughStyle, StyledText, TextRun,
    UnderlineStyle,
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
) -> Vec<StyledText> {
    rows.iter()
        .take(frame.size.rows())
        .enumerate()
        .map(|(row, cells)| {
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
                    !matches!(frame.cursor.shape, CursorShape::Hidden)
                        && frame.cursor.point.line.0 >= 0
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
                        runs.push(text_run(start - run_start, previous));
                        current = Some((style, start));
                    }
                    None => current = Some((style, start)),
                }
            }
            if let Some((style, run_start)) = current {
                runs.push(text_run(text.len() - run_start, style));
            }
            StyledText::new(text).with_runs(runs)
        })
        .collect()
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

fn text_run(len: usize, style: RunStyle) -> TextRun {
    let foreground = hsla(style.foreground);
    let mut font = font("Consolas");
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
