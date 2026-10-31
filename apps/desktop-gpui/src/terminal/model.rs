use cli_manager_core::pty_frame::BINARY_KIND_REPLAY_RESET;
use cli_manager_pty_client::{frame::Output, session::SessionLedger};
use cli_manager_term_engine::{Cell, Engine, Event, EventProxy, FrameSnapshot, Size};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};

/// The parse owner outlives individual views. Hiding a pane does not stop parsing.
pub struct TerminalModel {
    session_id: String,
    ledger: SessionLedger,
    engine: Engine,
    pub revision: u64,
    events: mpsc::Receiver<Event>,
    event_overflow: Arc<AtomicBool>,
    rendered_rows: Vec<Vec<Cell>>,
}

impl TerminalModel {
    pub fn new(session_id: String) -> Result<Self, String> {
        let mut ledger = SessionLedger::default();
        ledger.register(&session_id)?;
        let (sender, receiver) = mpsc::sync_channel(256);
        let event_overflow = Arc::new(AtomicBool::new(false));
        let overflow_writer = event_overflow.clone();
        let events = EventProxy::new(move |event| {
            if sender.try_send(event).is_err() {
                overflow_writer.store(true, Ordering::Release);
            }
        });
        Ok(Self {
            session_id,
            ledger,
            engine: Engine::new(Size::new(80, 24)?, 10_000, events)?,
            revision: 1,
            events: receiver,
            event_overflow,
            rendered_rows: vec![Vec::new(); 24],
        })
    }

    /// Returns true only after parsing and committing; only then may the caller ACK.
    pub fn apply(&mut self, output: &Output) -> Result<bool, String> {
        if output.session_id != self.session_id {
            return Ok(false);
        }
        let size = Size::new(output.cols as usize, output.rows as usize)?;
        if output.kind == BINARY_KIND_REPLAY_RESET {
            self.ledger.reset_replay(&self.session_id)?;
            self.engine.reset(size);
            self.rendered_rows = vec![Vec::new(); size.rows()];
            self.revision = self.revision.wrapping_add(1);
            return Ok(false);
        }
        let Some(ticket) = self.ledger.begin(&self.session_id, output.sequence)? else {
            return Ok(false);
        };
        self.engine.resize(size);
        self.engine.advance(&output.data);
        let committed = self.ledger.commit(ticket);
        if committed {
            self.revision = self.revision.wrapping_add(1);
        }
        Ok(committed)
    }

    pub fn snapshot(&mut self) -> FrameSnapshot {
        let frame = self.engine.snapshot();
        if frame.full || self.rendered_rows.len() != frame.size.rows() {
            self.rendered_rows = vec![Vec::new(); frame.size.rows()];
        }
        for (row, cells) in &frame.rows {
            if *row < self.rendered_rows.len() {
                self.rendered_rows[*row] = cells.clone();
            }
        }
        frame
    }

    pub fn styled_lines(
        &mut self,
        selection: Option<((usize, usize), (usize, usize))>,
        query: &str,
    ) -> Vec<gpui::StyledText> {
        let frame = self.snapshot();
        let urls = cli_manager_term_engine::search::find_urls(&self.rendered_rows);
        let search = cli_manager_term_engine::search::find_matches(&self.rendered_rows, query);
        crate::terminal::render::styled_lines(
            &self.rendered_rows,
            &frame,
            selection,
            &urls,
            &search,
        )
    }

    pub fn selected_text(&mut self, selection: ((usize, usize), (usize, usize))) -> String {
        self.snapshot();
        let (start, end) = if selection.0 <= selection.1 {
            selection
        } else {
            (selection.1, selection.0)
        };
        let mut output = String::new();
        for row in start.0..=end.0.min(self.rendered_rows.len().saturating_sub(1)) {
            let first = if row == start.0 { start.1 } else { 0 };
            let last = if row == end.0 {
                end.1
            } else {
                self.rendered_rows[row].len().saturating_sub(1)
            };
            let mut line = String::new();
            for cell in self.rendered_rows[row]
                .iter()
                .skip(first)
                .take(last.saturating_sub(first).saturating_add(1))
            {
                if cell
                    .flags
                    .contains(cli_manager_term_engine::CellFlags::WIDE_CHAR_SPACER)
                {
                    continue;
                }
                line.push(cell.c);
                if let Some(chars) = cell.zerowidth() {
                    line.extend(chars.iter().copied());
                }
            }
            output.push_str(line.trim_end_matches(' '));
            if row < end.0 {
                output.push('\n');
            }
        }
        output
    }

    #[allow(dead_code)]
    pub fn search_matches(
        &mut self,
        query: &str,
    ) -> Vec<cli_manager_term_engine::search::TextSpan> {
        self.snapshot();
        cli_manager_term_engine::search::find_matches(&self.rendered_rows, query)
    }

    #[allow(dead_code)]
    pub fn url_matches(&mut self) -> Vec<cli_manager_term_engine::search::TextSpan> {
        self.snapshot();
        cli_manager_term_engine::search::find_urls(&self.rendered_rows)
    }

    #[allow(dead_code)]
    pub fn url_at(&mut self, position: (usize, usize)) -> Option<String> {
        self.snapshot();
        let span = cli_manager_term_engine::search::find_urls(&self.rendered_rows)
            .into_iter()
            .find(|span| {
                span.row == position.0
                    && position.1 >= span.start_column
                    && position.1 < span.end_column
            })?;
        let row = self.rendered_rows.get(span.row)?;
        let value: String = row
            .iter()
            .skip(span.start_column)
            .take(span.end_column.saturating_sub(span.start_column))
            .filter(|cell| {
                !cell
                    .flags
                    .contains(cli_manager_term_engine::CellFlags::WIDE_CHAR_SPACER)
            })
            .flat_map(|cell| {
                std::iter::once(cell.c).chain(cell.zerowidth().into_iter().flatten().copied())
            })
            .collect();
        (!value.is_empty()).then_some(value)
    }

    pub fn input_mode(&self) -> cli_manager_term_engine::input::InputMode {
        self.engine.input_mode()
    }

    pub fn mouse_input_mode(&self) -> cli_manager_term_engine::input::MouseInputMode {
        self.engine.mouse_input_mode()
    }

    pub fn scroll(&mut self, lines: i32) {
        if lines != 0 {
            self.engine.scroll(lines);
            self.revision = self.revision.wrapping_add(1);
        }
    }

    /// Creates a visible-screen checkpoint without advancing the daemon ACK cursor.
    /// The caller uploads it with the latest committed sequence.
    #[allow(dead_code)]
    pub fn serialize_checkpoint(&self) -> Vec<u8> {
        self.engine.serialize_to_ansi()
    }

    pub fn checkpoint_payload(&self) -> (u16, u16, Vec<u8>) {
        (
            self.engine.columns() as u16,
            self.engine.rows() as u16,
            self.serialize_checkpoint(),
        )
    }

    pub fn session_id(&self) -> String {
        self.session_id.clone()
    }
    pub fn after_sequence(&self) -> Option<u64> {
        self.ledger.after_sequence(&self.session_id)
    }
    pub fn events(&mut self) -> Result<Vec<Event>, String> {
        if self.event_overflow.load(Ordering::Acquire) {
            return Err("terminal event queue overflow".into());
        }
        Ok(self.events.try_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn output(sequence: u64, kind: u8, text: &str) -> Output {
        Output {
            session_id: "s".into(),
            sequence,
            kind,
            cols: 80,
            rows: 24,
            data: text.to_owned().into_bytes().into(),
        }
    }
    #[test]
    fn parse_commit_filters_duplicates_and_reset_allows_older_replay() {
        let mut model = TerminalModel::new("s".into()).unwrap();
        assert!(model.apply(&output(9, 1, "old")).unwrap());
        assert!(!model.apply(&output(9, 2, "duplicate")).unwrap());
        assert!(!model.apply(&output(0, 5, "")).unwrap());
        assert!(model.apply(&output(2, 2, "new")).unwrap());
        let frame = model.snapshot();
        assert_eq!(
            frame.rows[0]
                .1
                .iter()
                .take(3)
                .map(|c| c.c)
                .collect::<String>(),
            "new"
        );
        assert!(model.serialize_checkpoint().starts_with(b"\x1b[2J\x1b[H"));
    }
    #[test]
    fn invalid_geometry_does_not_commit_and_foreign_session_is_ignored() {
        let mut model = TerminalModel::new("s".into()).unwrap();
        let mut frame = output(1, 1, "text");
        frame.cols = 0;
        assert!(model.apply(&frame).is_err());
        frame.cols = 80;
        assert!(model.apply(&frame).unwrap());
        frame.session_id = "foreign".into();
        assert!(!model.apply(&frame).unwrap());
    }

    #[test]
    fn selected_text_preserves_line_breaks_and_normalizes_reverse_drag() {
        let mut model = TerminalModel::new("s".into()).unwrap();
        assert!(model.apply(&output(1, 1, "one\r\ntwo")).unwrap());
        assert_eq!(model.selected_text(((1, 2), (0, 0))), "one\ntwo");
    }

    #[test]
    fn url_at_returns_only_the_url_under_a_terminal_cell() {
        let mut model = TerminalModel::new("s".into()).unwrap();
        assert!(model
            .apply(&output(1, 1, "go https://example.com now"))
            .unwrap());
        assert_eq!(model.url_at((0, 7)).as_deref(), Some("https://example.com"));
        assert_eq!(model.url_at((0, 2)), None);
    }
}
