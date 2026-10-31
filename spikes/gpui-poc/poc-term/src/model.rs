use alacritty_terminal::{
    event::VoidListener,
    grid::Dimensions,
    index::{Column, Line},
    term::{cell::Flags, Config, TermDamage},
    vte::ansi::Processor,
    Term,
};
use std::time::Instant;

pub const COLS: usize = 80;
pub const ROWS: usize = 24;
struct Size;
impl Dimensions for Size {
    fn columns(&self) -> usize {
        COLS
    }
    fn screen_lines(&self) -> usize {
        ROWS
    }
    fn total_lines(&self) -> usize {
        ROWS
    }
}

pub struct Model {
    pub term: Term<VoidListener>,
    parser: Processor,
    pub bytes: u64,
    pub parse_ns: u128,
    pub first: Option<Instant>,
    pub last: Option<Instant>,
    pub done: bool,
    pub error: bool,
}
impl Model {
    pub fn new() -> Self {
        Self {
            term: Term::new(Config::default(), &Size, VoidListener),
            parser: Processor::new(),
            bytes: 0,
            parse_ns: 0,
            first: None,
            last: None,
            done: false,
            error: false,
        }
    }
    pub fn reset(&mut self) {
        self.term = Term::new(Config::default(), &Size, VoidListener);
        self.parser = Processor::new();
    }
    pub fn advance(&mut self, data: &[u8]) {
        let start = Instant::now();
        self.first.get_or_insert(start);
        self.parser.advance(&mut self.term, data);
        self.parse_ns += start.elapsed().as_nanos();
        self.bytes += data.len() as u64;
        self.last = Some(Instant::now());
    }
    pub fn damaged(&mut self) -> Vec<(usize, String)> {
        let rows: Vec<_> = match self.term.damage() {
            TermDamage::Full => (0..ROWS).collect(),
            TermDamage::Partial(lines) => lines.map(|l| l.line).collect(),
        };
        let lines = rows
            .into_iter()
            .filter(|&y| y < ROWS)
            .map(|y| {
                let mut text = String::new();
                for x in 0..COLS {
                    let cell = &self.term.grid()[Line(y as i32)][Column(x)];
                    if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                        continue;
                    }
                    text.push(cell.c);
                    if let Some(chars) = cell.zerowidth() {
                        text.extend(chars);
                    }
                }
                (y, text)
            })
            .collect();
        self.term.reset_damage();
        lines
    }
}
