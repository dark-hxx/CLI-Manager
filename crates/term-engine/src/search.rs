use crate::{Cell, CellFlags};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextSpan {
    pub row: usize,
    pub start_column: usize,
    pub end_column: usize,
}

/// Finds case-insensitive query matches while preserving terminal columns.
/// Wide-character spacer cells are ignored, but their leading cell remains in
/// the returned span so callers can highlight the complete terminal glyph.
pub fn find_matches(rows: &[Vec<Cell>], query: &str) -> Vec<TextSpan> {
    let query: Vec<char> = query.chars().flat_map(char::to_lowercase).collect();
    if query.is_empty() {
        return Vec::new();
    }

    let mut matches = Vec::new();
    for (row, cells) in rows.iter().enumerate() {
        let chars: Vec<(usize, char)> = cells
            .iter()
            .enumerate()
            .filter(|(_, cell)| !cell.flags.contains(CellFlags::WIDE_CHAR_SPACER))
            .map(|(column, cell)| (column, cell.c.to_lowercase().next().unwrap_or(cell.c)))
            .collect();
        for window in chars.windows(query.len()) {
            if window.iter().map(|(_, ch)| *ch).eq(query.iter().copied()) {
                matches.push(TextSpan {
                    row,
                    start_column: window[0].0,
                    end_column: window[window.len() - 1].0 + 1,
                });
            }
        }
    }
    matches
}

/// Finds common terminal URLs without requiring a regex or allocation-heavy
/// parser. Punctuation adjacent to a URL is excluded from the clickable span.
pub fn find_urls(rows: &[Vec<Cell>]) -> Vec<TextSpan> {
    rows.iter()
        .enumerate()
        .flat_map(|(row, cells)| {
            let chars: Vec<(usize, char)> = cells
                .iter()
                .enumerate()
                .filter(|(_, cell)| !cell.flags.contains(CellFlags::WIDE_CHAR_SPACER))
                .map(|(column, cell)| (column, cell.c))
                .collect();
            let mut spans = Vec::new();
            let mut index = 0;
            while index < chars.len() {
                let Some(scheme_len) = scheme_length(&chars[index..]) else {
                    index += 1;
                    continue;
                };
                let mut end = index + scheme_len;
                while end < chars.len()
                    && !chars[end].1.is_whitespace()
                    && !chars[end].1.is_control()
                {
                    end += 1;
                }
                while end > index + scheme_len && is_trailing_url_punctuation(chars[end - 1].1) {
                    end -= 1;
                }
                if end > index + scheme_len {
                    spans.push(TextSpan {
                        row,
                        start_column: chars[index].0,
                        end_column: chars[end - 1].0 + 1,
                    });
                }
                index = end.max(index + 1);
            }
            spans
        })
        .collect()
}

fn scheme_length(chars: &[(usize, char)]) -> Option<usize> {
    ["https://", "http://", "file://", "ssh://"]
        .iter()
        .find_map(|scheme| {
            let scheme_chars: Vec<char> = scheme.chars().collect();
            chars
                .get(..scheme_chars.len())
                .filter(|prefix| {
                    prefix
                        .iter()
                        .map(|(_, ch)| ch.to_ascii_lowercase())
                        .eq(scheme_chars.iter().copied())
                })
                .map(|_| scheme_chars.len())
        })
}

fn is_trailing_url_punctuation(character: char) -> bool {
    matches!(
        character,
        '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Engine, EventProxy, Size};

    fn rows(text: &str) -> Vec<Vec<Cell>> {
        let proxy = EventProxy::new(|_| {});
        let mut engine = Engine::new(Size::new(80, 3).unwrap(), 100, proxy).unwrap();
        engine.advance(text.as_bytes());
        engine
            .snapshot()
            .rows
            .into_iter()
            .map(|(_, cells)| cells)
            .collect()
    }

    #[test]
    fn finds_case_insensitive_matches_by_terminal_column() {
        let rows = rows("Alpha alpha");
        assert_eq!(
            find_matches(&rows, "ALPHA"),
            vec![
                TextSpan {
                    row: 0,
                    start_column: 0,
                    end_column: 5
                },
                TextSpan {
                    row: 0,
                    start_column: 6,
                    end_column: 11
                },
            ]
        );
    }

    #[test]
    fn finds_urls_and_excludes_sentence_punctuation() {
        let rows = rows("See https://example.com, and file:///tmp/x.");
        assert_eq!(
            find_urls(&rows),
            vec![
                TextSpan {
                    row: 0,
                    start_column: 4,
                    end_column: 23
                },
                TextSpan {
                    row: 0,
                    start_column: 29,
                    end_column: 42
                },
            ]
        );
    }

    #[test]
    fn empty_query_and_plain_text_have_no_matches() {
        let rows = rows("plain text");
        assert!(find_matches(&rows, "").is_empty());
        assert!(find_urls(&rows).is_empty());
    }
}
