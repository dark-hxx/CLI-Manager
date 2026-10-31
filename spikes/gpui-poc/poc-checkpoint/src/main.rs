//! Isolated visible-grid experiment; not a complete daemon checkpoint encoder.
use alacritty_terminal::{
    event::VoidListener,
    grid::Dimensions,
    index::{Column, Line},
    term::{cell::Flags, Config, TermMode},
    vte::ansi::{Color, NamedColor, Processor},
    Term,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read};

#[derive(Deserialize)]
struct Case {
    name: String,
    cols: usize,
    rows: usize,
    ansi: String,
}
struct Size {
    cols: usize,
    rows: usize,
}
impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}
fn color(value: Color, foreground: bool) -> String {
    match value {
        Color::Spec(c) => format!("rgb:{},{},{}", c.r, c.g, c.b),
        Color::Indexed(i) => format!("index:{i}"),
        Color::Named(n) if n == NamedColor::Foreground || n == NamedColor::Background => {
            "default".into()
        }
        Color::Named(n) if (n as usize) < 16 => format!("index:{}", n as usize),
        _ => format!("unsupported:{}:{value:?}", foreground),
    }
}
fn sgr_color(c: Color, foreground: bool) -> String {
    let base = if foreground { 38 } else { 48 };
    match c {
        Color::Spec(c) => format!("{base};2;{};{};{}", c.r, c.g, c.b),
        Color::Indexed(i) => format!("{base};5;{i}"),
        Color::Named(n) if (n as usize) < 16 => format!("{base};5;{}", n as usize),
        _ => if foreground { "39" } else { "49" }.into(),
    }
}
fn run(case: Case) -> Value {
    assert!((2..=512).contains(&case.cols) && (1..=256).contains(&case.rows));
    let mut term = Term::new(
        Config::default(),
        &Size {
            cols: case.cols,
            rows: case.rows,
        },
        VoidListener,
    );
    let mut processor: Processor = Processor::new();
    processor.advance(&mut term, case.ansi.as_bytes());
    let alternate = term.mode().contains(TermMode::ALT_SCREEN);
    let mut ansi = String::from("\x1bc");
    if alternate {
        ansi.push_str("\x1b[?1049h");
    }
    let mut rows = Vec::new();
    let mut hyperlinks = 0;
    for row in 0..case.rows {
        ansi.push_str(&format!("\x1b[{};1H", row + 1));
        let mut cells = Vec::new();
        for col in 0..case.cols {
            let c = &term.grid()[Line(row as i32)][Column(col)];
            let width = if c.flags.contains(Flags::WIDE_CHAR_SPACER) {
                0
            } else if c.flags.contains(Flags::WIDE_CHAR) {
                2
            } else {
                1
            };
            let mut text = if width == 0 {
                String::new()
            } else {
                c.c.to_string()
            };
            if let Some(chars) = c.zerowidth() {
                text.extend(chars.iter());
            }
            let flags = [
                Flags::BOLD,
                Flags::ITALIC,
                Flags::DIM,
                Flags::UNDERLINE,
                Flags::INVERSE,
                Flags::HIDDEN,
                Flags::STRIKEOUT,
            ];
            let attrs: Vec<_> = flags.iter().map(|flag| c.flags.contains(*flag)).collect();
            cells.push(json!({"text":text,"width":width,"fg":color(c.fg,true),
                "bg":color(c.bg,false),"attrs":attrs,
                "hyperlink":c.hyperlink().map(|link| json!({"id":link.id(),"uri":link.uri()}))}));
            if width == 0 {
                continue;
            }
            ansi.push_str("\x1b[0m");
            let mut codes = vec![sgr_color(c.fg, true), sgr_color(c.bg, false)];
            for (flag, code) in flags.iter().zip([1, 3, 2, 4, 7, 8, 9]) {
                if c.flags.contains(*flag) {
                    codes.push(code.to_string());
                }
            }
            ansi.push_str(&format!("\x1b[{}m", codes.join(";")));
            if let Some(link) = c.hyperlink() {
                hyperlinks += 1;
                // Input was parsed by vte; still refuse control characters in an OSC payload.
                if !link.uri().chars().any(char::is_control)
                    && !link
                        .id()
                        .chars()
                        .any(|c| c.is_control() || c == ':' || c == ';')
                {
                    ansi.push_str(&format!("\x1b]8;id={};{}\x1b\\", link.id(), link.uri()));
                }
            }
            ansi.push_str(&text);
            ansi.push_str("\x1b]8;;\x1b\\");
        }
        rows.push(cells);
    }
    let p = term.grid().cursor.point;
    let visible = term.mode().contains(TermMode::SHOW_CURSOR);
    let paste = term.mode().contains(TermMode::BRACKETED_PASTE);
    ansi.push_str(&format!(
        "\x1b[0m\x1b[{};{}H\x1b[?25{}\x1b[?2004{}",
        p.line.0 + 1,
        p.column.0 + 1,
        if visible { "h" } else { "l" },
        if paste { "h" } else { "l" }
    ));
    json!({"name":case.name,"snapshot":{"rows":rows,"cursor":[p.column.0,p.line.0],
        "alternate":alternate,"cursorVisible":visible,"bracketedPaste":paste},
        "ansi":ansi,"hyperlinkCells":hyperlinks,
        "scope":"active viewport only; inactive buffer/history/scroll margins/wrap-pending not encoded"})
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin()
        .take(16 * 1024 * 1024)
        .read_to_string(&mut input)?;
    let cases: Vec<Case> = serde_json::from_str(&input)?;
    let result: Vec<_> = cases.into_iter().map(run).collect();
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
