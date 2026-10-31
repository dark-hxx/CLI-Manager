//! VT state independent from transport and UI. The parse owner serializes all mutations.
use alacritty_terminal::{
    event::EventListener,
    grid::{Dimensions, Scroll},
    index::{Column, Line},
    term::{Config, Osc52, RenderableCursor, TermDamage, TermMode},
    vte::ansi::Processor,
    Term,
};
use std::sync::Arc;

pub mod input;
pub mod search;
pub use alacritty_terminal::term::cell::Flags as CellFlags;
pub use alacritty_terminal::term::color::Colors;
pub use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Rgb};
pub use alacritty_terminal::{event::Event, term::cell::Cell};

/// Synchronous adapter: hosts must enqueue events without waiting for the network or UI.
/// Clipboard events are requests only; this crate never accesses the system clipboard.
#[derive(Clone)]
pub struct EventProxy(Arc<dyn Fn(Event) + Send + Sync>);

impl EventProxy {
    pub fn new(callback: impl Fn(Event) + Send + Sync + 'static) -> Self {
        Self(Arc::new(callback))
    }
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        (self.0)(event);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    columns: usize,
    rows: usize,
}

impl Size {
    pub fn new(columns: usize, rows: usize) -> Result<Self, &'static str> {
        if columns < 2
            || rows == 0
            || columns > 4096
            || rows > 4096
            || columns.saturating_mul(rows) > 1_048_576
        {
            return Err("invalid terminal size");
        }
        Ok(Self { columns, rows })
    }

    pub fn columns(self) -> usize {
        self.columns
    }
    pub fn rows(self) -> usize {
        self.rows
    }
}

impl Dimensions for Size {
    fn columns(&self) -> usize {
        self.columns
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn total_lines(&self) -> usize {
        self.rows
    }
}

/// Owned damage update. Keep the previous rows when `full` is false.
/// Cell attributes include wide spacers, combining marks, colors and OSC 8 links.
pub struct FrameSnapshot {
    pub size: Size,
    pub full: bool,
    pub rows: Vec<(usize, Vec<Cell>)>,
    pub cursor: RenderableCursor,
    pub mode: TermMode,
    pub display_offset: usize,
    pub colors: Colors,
}

pub struct Engine {
    term: Term<EventProxy>,
    parser: Processor,
    size: Size,
    config: Config,
    events: EventProxy,
}

impl Engine {
    pub fn new(size: Size, scrollback: usize, events: EventProxy) -> Result<Self, &'static str> {
        if scrollback > 100_000 {
            return Err("scrollback limit exceeded");
        }
        // Host approval is required for OSC52; never enable read/write by default.
        let config = Config {
            scrolling_history: scrollback,
            osc52: Osc52::Disabled,
            kitty_keyboard: true,
            ..Config::default()
        };
        Ok(Self {
            term: Term::new(config.clone(), &size, events.clone()),
            parser: Processor::new(),
            size,
            config,
            events,
        })
    }

    pub fn advance(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    pub fn resize(&mut self, size: Size) {
        if size != self.size {
            self.term.resize(size);
            self.size = size;
        }
    }

    /// Replay reset discards parser partial sequences and both terminal grids.
    pub fn reset(&mut self, size: Size) {
        self.size = size;
        self.term = Term::new(self.config.clone(), &size, self.events.clone());
        self.parser = Processor::new();
    }

    pub fn scroll(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
    }

    pub fn mode(&self) -> TermMode {
        *self.term.mode()
    }

    pub fn columns(&self) -> usize {
        self.size.columns()
    }
    pub fn rows(&self) -> usize {
        self.size.rows()
    }

    pub fn input_mode(&self) -> input::InputMode {
        input::InputMode {
            application_cursor: self.term.mode().contains(TermMode::APP_CURSOR),
            kitty_keyboard: self.term.mode().contains(TermMode::KITTY_KEYBOARD_PROTOCOL),
            bracketed_paste: self.term.mode().contains(TermMode::BRACKETED_PASTE),
        }
    }

    pub fn mouse_input_mode(&self) -> input::MouseInputMode {
        input::MouseInputMode {
            click: self.term.mode().contains(TermMode::MOUSE_REPORT_CLICK),
            drag: self.term.mode().contains(TermMode::MOUSE_DRAG),
            motion: self.term.mode().contains(TermMode::MOUSE_MOTION),
            sgr: self.term.mode().contains(TermMode::SGR_MOUSE),
        }
    }

    /// Called by the single display owner under its model lock, then release before shaping.
    pub fn snapshot(&mut self) -> FrameSnapshot {
        let (full, damaged): (bool, Vec<usize>) = match self.term.damage() {
            TermDamage::Full => (true, (0..self.size.rows).collect()),
            TermDamage::Partial(lines) => (false, lines.map(|line| line.line).collect()),
        };
        let content = self.term.renderable_content();
        let offset = content.display_offset;
        let rows = damaged
            .into_iter()
            .filter(|row| *row < self.size.rows)
            .map(|row| {
                let line = Line(row as i32 - offset as i32);
                let cells = (0..self.size.columns)
                    .map(|col| self.term.grid()[line][Column(col)].clone())
                    .collect();
                (row, cells)
            })
            .collect();
        let frame = FrameSnapshot {
            size: self.size,
            full,
            rows,
            cursor: content.cursor,
            mode: content.mode,
            display_offset: offset,
            colors: *content.colors,
        };
        self.term.reset_damage();
        frame
    }

    /// Serialize the current visible grid into a replayable ANSI checkpoint.
    ///
    /// The checkpoint intentionally starts from a cleared viewport and restores
    /// terminal mode, cell SGR, hyperlinks, combining marks and cursor position.
    /// Scrollback and parser-incomplete state remain transport concerns and are
    /// therefore reset before the checkpoint is applied.
    pub fn serialize_to_ansi(&self) -> Vec<u8> {
        let mut output = Vec::new();
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            output.extend_from_slice(b"\x1b[?1049h");
        }
        output.extend_from_slice(b"\x1b[2J\x1b[H");
        for row in 0..self.size.rows {
            for column in 0..self.size.columns {
                let cell = &self.term.grid()[Line(row as i32)][Column(column)];
                if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                    continue;
                }
                output.extend_from_slice(b"\x1b[0m");
                append_cell_style(&mut output, cell.fg, cell.bg, cell.flags);
                if let Some(link) = cell.hyperlink() {
                    output.extend_from_slice(b"\x1b]8;");
                    output.extend_from_slice(sanitize_osc(link.id()).as_bytes());
                    output.push(b';');
                    output.extend_from_slice(sanitize_osc(link.uri()).as_bytes());
                    output.extend_from_slice(b"\x1b\\");
                }
                let mut text = String::new();
                text.push(cell.c);
                if let Some(zerowidth) = cell.zerowidth() {
                    text.extend(zerowidth.iter().copied());
                }
                output.extend_from_slice(text.as_bytes());
                if cell.hyperlink().is_some() {
                    output.extend_from_slice(b"\x1b]8;;\x1b\\");
                }
            }
            if row + 1 < self.size.rows {
                output.extend_from_slice(b"\r\n");
            }
        }
        if self.term.mode().contains(TermMode::APP_CURSOR) {
            output.extend_from_slice(b"\x1b[?1h");
        }
        if !self.term.mode().contains(TermMode::SHOW_CURSOR) {
            output.extend_from_slice(b"\x1b[?25l");
        }
        let cursor = self.term.renderable_content().cursor.point;
        output.extend_from_slice(
            format!("\x1b[{};{}H", cursor.line.0 + 1, cursor.column.0 + 1).as_bytes(),
        );
        output
    }
}

fn sanitize_osc(value: &str) -> String {
    value
        .chars()
        .filter(|character| *character != '\x1b' && *character != '\x07')
        .collect()
}

fn append_cell_style(output: &mut Vec<u8>, fg: Color, bg: Color, flags: CellFlags) {
    let mut params = Vec::new();
    if flags.contains(CellFlags::BOLD) {
        params.push("1".to_owned());
    }
    if flags.contains(CellFlags::DIM) {
        params.push("2".to_owned());
    }
    if flags.contains(CellFlags::ITALIC) {
        params.push("3".to_owned());
    }
    if flags.intersects(CellFlags::ALL_UNDERLINES) {
        params.push("4".to_owned());
    }
    if flags.contains(CellFlags::INVERSE) {
        params.push("7".to_owned());
    }
    if flags.contains(CellFlags::HIDDEN) {
        params.push("8".to_owned());
    }
    if flags.contains(CellFlags::STRIKEOUT) {
        params.push("9".to_owned());
    }
    append_color(&mut params, fg, false);
    append_color(&mut params, bg, true);
    if !params.is_empty() {
        output.extend_from_slice(format!("\x1b[{}m", params.join(";")).as_bytes());
    }
}

fn append_color(params: &mut Vec<String>, color: Color, background: bool) {
    let offset = if background { 10 } else { 0 };
    match color {
        Color::Named(NamedColor::Foreground) => {
            params.push(if background { "49" } else { "39" }.into())
        }
        Color::Named(NamedColor::Background) => {
            params.push(if background { "49" } else { "39" }.into())
        }
        Color::Named(named) => {
            let code = match named {
                NamedColor::Black => 0,
                NamedColor::Red => 1,
                NamedColor::Green => 2,
                NamedColor::Yellow => 3,
                NamedColor::Blue => 4,
                NamedColor::Magenta => 5,
                NamedColor::Cyan => 6,
                NamedColor::White => 7,
                NamedColor::BrightBlack => 0,
                NamedColor::BrightRed => 1,
                NamedColor::BrightGreen => 2,
                NamedColor::BrightYellow => 3,
                NamedColor::BrightBlue => 4,
                NamedColor::BrightMagenta => 5,
                NamedColor::BrightCyan => 6,
                NamedColor::BrightWhite => 7,
                _ => return,
            };
            let bright = matches!(
                named,
                NamedColor::BrightBlack
                    | NamedColor::BrightRed
                    | NamedColor::BrightGreen
                    | NamedColor::BrightYellow
                    | NamedColor::BrightBlue
                    | NamedColor::BrightMagenta
                    | NamedColor::BrightCyan
                    | NamedColor::BrightWhite
            );
            params.push((if bright { 90 } else { 30 } + code + offset).to_string());
        }
        Color::Indexed(index) => {
            params.push(format!("{};5;{}", if background { 48 } else { 38 }, index))
        }
        Color::Spec(rgb) => params.push(format!(
            "{};2;{};{};{}",
            if background { 48 } else { 38 },
            rgb.r,
            rgb.g,
            rgb.b
        )),
    }
}

#[cfg(test)]
mod tests;
