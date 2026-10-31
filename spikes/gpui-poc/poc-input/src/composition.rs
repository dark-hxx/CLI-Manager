//! UTF-16 platform ranges converted without splitting a Rust scalar value.
use std::ops::Range;

#[derive(Default)]
pub struct Composition {
    pub text: String,
    pub selected: Range<usize>,
    pub marked: Option<Range<usize>>,
}

fn byte_offset(text: &str, target: usize, round_up: bool) -> usize {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units >= target {
            return byte;
        }
        units += ch.len_utf16();
        if units > target {
            return byte + if round_up { ch.len_utf8() } else { 0 };
        }
    }
    text.len()
}

impl Composition {
    pub fn bytes(&self, range: Range<usize>) -> Range<usize> {
        let start = byte_offset(&self.text, range.start.min(range.end), false);
        let end = byte_offset(&self.text, range.end.max(range.start), true);
        start..end
    }

    pub fn utf16(&self, range: Range<usize>) -> Range<usize> {
        self.text[..range.start].encode_utf16().count()
            ..self.text[..range.end].encode_utf16().count()
    }

    pub fn replace(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        mark: bool,
    ) {
        let range = range
            .map(|r| self.bytes(r))
            .or_else(|| self.marked.clone())
            .unwrap_or(self.selected.clone());
        self.text.replace_range(range.clone(), text);
        self.marked = (mark && !text.is_empty()).then_some(range.start..range.start + text.len());
        self.selected = if mark {
            selected
                .map(|r| {
                    let start = byte_offset(text, r.start.min(r.end), false);
                    let end = byte_offset(text, r.end.max(r.start), true);
                    range.start + start..range.start + end
                })
                .unwrap_or(range.start + text.len()..range.start + text.len())
        } else {
            range.start + text.len()..range.start + text.len()
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composition_replaces_marked_text_once_and_preserves_suffix() {
        let mut state = Composition {
            text: "A🙂尾".into(),
            selected: 1..5,
            marked: None,
        };
        state.replace(None, "ni", Some(2..2), true);
        state.replace(None, "你", None, true);
        state.replace(None, "你好", None, false);
        assert_eq!(state.text, "A你好尾");
        assert!(state.marked.is_none());
        assert_eq!(state.utf16(state.selected.clone()), 3..3);
    }
    #[test]
    fn malformed_surrogate_ranges_never_split_scalar_values() {
        let state = Composition {
            text: "A🙂B".into(),
            ..Default::default()
        };
        assert_eq!(state.bytes(2..2), 1..5);
        assert_eq!(state.bytes(100..200), 6..6);
        assert_eq!(state.bytes(3..1), 1..5);
    }
    #[test]
    fn empty_mark_cancels_without_duplicate_text() {
        let mut state = Composition::default();
        state.replace(None, "ni", None, true);
        state.replace(None, "", None, true);
        assert_eq!(state.text, "");
        assert!(state.marked.is_none());
    }
}
