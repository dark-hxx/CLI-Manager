use gpui::{font, rgba, FontWeight, Hsla, StyledText, TextRun};
use tree_sitter::{Language, Node, Parser};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffLineKind {
    Context,
    Header,
    Hunk,
    Added,
    Removed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffToken {
    pub start: usize,
    pub end: usize,
    pub color: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighlightedDiffLine {
    pub text: String,
    pub kind: DiffLineKind,
    pub tokens: Vec<DiffToken>,
}

pub fn highlight_diff(text: &str) -> Vec<HighlightedDiffLine> {
    highlight_diff_with_language(text, None)
}

pub fn highlight_diff_for_path(path: &str, text: &str) -> Vec<HighlightedDiffLine> {
    highlight_diff_with_language(text, language_for_path(path))
}

fn highlight_diff_with_language(
    text: &str,
    language: Option<Language>,
) -> Vec<HighlightedDiffLine> {
    let mut lines = text
        .lines()
        .map(|line| HighlightedDiffLine {
            text: line.to_owned(),
            kind: line_kind(line),
            tokens: syntax_tokens(line),
        })
        .collect::<Vec<_>>();
    let Some(language) = language else {
        return lines;
    };

    let mut source = String::new();
    let mut mappings = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !matches!(
            line.kind,
            DiffLineKind::Context | DiffLineKind::Added | DiffLineKind::Removed
        ) {
            continue;
        }
        let content = match line.kind {
            DiffLineKind::Added | DiffLineKind::Removed => line.text.get(1..).unwrap_or_default(),
            DiffLineKind::Context => line.text.as_str(),
            _ => unreachable!(),
        };
        let start = source.len();
        source.push_str(content);
        source.push('\n');
        mappings.push((index, start, start + content.len()));
    }
    if source.is_empty() {
        return lines;
    }

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return lines;
    }
    let Some(tree) = parser.parse(&source, None) else {
        return lines;
    };
    collect_tree_tokens(tree.root_node(), &mappings, &mut lines);
    for line in &mut lines {
        line.tokens = normalize_tokens(std::mem::take(&mut line.tokens));
    }
    lines
}

fn language_for_path(path: &str) -> Option<Language> {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())?;
    match extension.as_str() {
        "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        "tsx" | "jsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "ts" | "js" | "mjs" | "cjs" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        _ => None,
    }
}

fn line_kind(line: &str) -> DiffLineKind {
    if line.starts_with("@@") {
        DiffLineKind::Hunk
    } else if line.starts_with("diff ")
        || line.starts_with("index ")
        || line.starts_with("--- ")
        || line.starts_with("+++ ")
    {
        DiffLineKind::Header
    } else if line.starts_with('+') {
        DiffLineKind::Added
    } else if line.starts_with('-') {
        DiffLineKind::Removed
    } else {
        DiffLineKind::Context
    }
}

fn collect_tree_tokens<'tree>(
    node: Node<'tree>,
    mappings: &[(usize, usize, usize)],
    lines: &mut [HighlightedDiffLine],
) {
    if let Some(color) = node_color(node.kind()) {
        let range = node.byte_range();
        for (line_index, line_start, line_end) in mappings {
            if range.start >= *line_end || range.end <= *line_start {
                continue;
            }
            let start = range.start.max(*line_start) - *line_start + 1;
            let end = range.end.min(*line_end) - *line_start + 1;
            if start < end {
                lines[*line_index]
                    .tokens
                    .push(DiffToken { start, end, color });
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_tree_tokens(child, mappings, lines);
    }
}

fn node_color(kind: &str) -> Option<u32> {
    let color = match kind {
        "comment" | "line_comment" | "block_comment" => 0x7f9f7f,
        "string" | "string_literal" | "raw_string_literal" | "template_string" => 0xd6ba7a,
        "integer_literal" | "float_literal" | "number" => 0xb5cea8,
        "type_identifier" | "type_annotation" | "primitive_type" => 0x4ec9b0,
        "field_identifier" | "property_identifier" => 0x9cdcfe,
        "fn" | "let" | "mut" | "pub" | "struct" | "enum" | "impl" | "use" | "const" | "match"
        | "if" | "else" | "for" | "while" | "return" | "async" | "await" | "function" | "class"
        | "import" | "export" | "var" | "interface" | "type" | "true" | "false" | "null" => {
            0xc586c0
        }
        _ => return None,
    };
    Some(color)
}

fn normalize_tokens(mut tokens: Vec<DiffToken>) -> Vec<DiffToken> {
    tokens.sort_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then_with(|| right.end.cmp(&left.end))
    });
    let mut normalized = Vec::with_capacity(tokens.len());
    for token in tokens {
        if token.start >= token.end
            || normalized
                .last()
                .is_some_and(|last: &DiffToken| token.start < last.end)
        {
            continue;
        }
        normalized.push(token);
    }
    normalized
}

fn syntax_tokens(line: &str) -> Vec<DiffToken> {
    let mut tokens = Vec::new();
    let mut index = 0;
    let bytes = line.as_bytes();
    while index < bytes.len() {
        if (bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/')) || bytes[index] == b'#' {
            tokens.push(DiffToken {
                start: index,
                end: bytes.len(),
                color: 0x7f9f7f,
            });
            break;
        }
        if matches!(bytes[index], b'\'' | b'"' | b'`') {
            let quote = bytes[index];
            let start = index;
            index += 1;
            while index < bytes.len() {
                let escaped = index > start && bytes[index - 1] == b'\\';
                if bytes[index] == quote && !escaped {
                    index += 1;
                    break;
                }
                index += 1;
            }
            tokens.push(DiffToken {
                start,
                end: index,
                color: 0xd6ba7a,
            });
            continue;
        }
        if bytes[index].is_ascii_digit() {
            let start = index;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'.' | b'_'))
            {
                index += 1;
            }
            tokens.push(DiffToken {
                start,
                end: index,
                color: 0xb5cea8,
            });
            continue;
        }
        if bytes[index].is_ascii_alphabetic() || bytes[index] == b'_' {
            let start = index;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
            {
                index += 1;
            }
            let word = &line[start..index];
            if matches!(
                word,
                "fn" | "let"
                    | "mut"
                    | "pub"
                    | "struct"
                    | "enum"
                    | "impl"
                    | "use"
                    | "const"
                    | "match"
                    | "if"
                    | "else"
                    | "for"
                    | "while"
                    | "return"
                    | "async"
                    | "await"
                    | "function"
                    | "class"
                    | "import"
                    | "export"
                    | "var"
                    | "interface"
                    | "type"
                    | "true"
                    | "false"
                    | "null"
            ) {
                tokens.push(DiffToken {
                    start,
                    end: index,
                    color: 0xc586c0,
                });
            }
            continue;
        }
        index += 1;
    }
    tokens
}

pub fn styled_diff_line(line: &HighlightedDiffLine, base_color: u32) -> StyledText {
    let mut runs = Vec::new();
    let mut cursor = 0;
    for token in &line.tokens {
        if token.start > cursor {
            runs.push(diff_text_run(token.start - cursor, base_color));
        }
        runs.push(diff_text_run(
            token.end.saturating_sub(token.start),
            token.color,
        ));
        cursor = token.end;
    }
    if cursor < line.text.len() {
        runs.push(diff_text_run(line.text.len() - cursor, base_color));
    }
    StyledText::new(line.text.clone()).with_runs(runs)
}

fn diff_text_run(len: usize, color: u32) -> TextRun {
    let mut font = font("Consolas");
    font.weight = FontWeight::NORMAL;
    TextRun {
        len,
        font,
        color: Hsla::from(rgba((color << 8) | 0xff)),
        background_color: None,
        underline: None,
        strikethrough: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_diff_uses_tree_sitter_node_ranges_for_tokens() {
        let lines = highlight_diff_for_path("src/main.rs", "+fn main() { let count: i32 = 42; }");
        let tokens = &lines[0].tokens;
        assert!(tokens.iter().any(|token| token.color == 0xc586c0));
        assert!(tokens.iter().any(|token| token.color == 0xb5cea8));
        assert!(tokens.iter().any(|token| token.color == 0x4ec9b0));
    }

    #[test]
    fn typescript_diff_parses_strings_and_keywords() {
        let lines = highlight_diff_for_path("src/main.ts", "+const value: string = \"ok\";");
        assert!(lines[0].tokens.iter().any(|token| token.color == 0xc586c0));
        assert!(lines[0].tokens.iter().any(|token| token.color == 0xd6ba7a));
    }
}
