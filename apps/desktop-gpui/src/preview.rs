use gpui::{div, prelude::*, px, rgb};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarkdownBlock {
    Heading {
        level: u8,
        text: String,
    },
    Paragraph(String),
    Bullet {
        checked: Option<bool>,
        text: String,
    },
    Ordered {
        index: usize,
        text: String,
    },
    Quote(String),
    Code {
        language: String,
        text: String,
    },
    Math {
        display: bool,
        text: String,
    },
    Table {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
        alignments: Vec<TableAlignment>,
    },
    Rule,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableAlignment {
    None,
    Left,
    Center,
    Right,
}

pub fn is_markdown(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, extension)| {
        matches!(
            extension.to_ascii_lowercase().as_str(),
            "md" | "markdown" | "mdown"
        )
    })
}

pub fn parse_markdown(source: &str) -> Vec<MarkdownBlock> {
    let mut blocks = Vec::new();
    let mut paragraph = Vec::new();
    let mut code = None::<(String, Vec<String>)>;
    let lines = source.lines().collect::<Vec<_>>();
    let mut line_index = 0;

    let flush_paragraph = |blocks: &mut Vec<MarkdownBlock>, paragraph: &mut Vec<String>| {
        if !paragraph.is_empty() {
            blocks.push(MarkdownBlock::Paragraph(normalize_inline(
                &paragraph.join(" "),
            )));
            paragraph.clear();
        }
    };

    while let Some(line) = lines.get(line_index).copied() {
        if let Some((language, lines)) = code.as_mut() {
            if line.trim_start().starts_with("```") {
                blocks.push(MarkdownBlock::Code {
                    language: language.clone(),
                    text: lines.join("\n"),
                });
                code = None;
            } else {
                lines.push(line.to_owned());
            }
            line_index += 1;
            continue;
        }

        let trimmed = line.trim();
        if let Some(language) = trimmed.strip_prefix("```") {
            flush_paragraph(&mut blocks, &mut paragraph);
            code = Some((language.trim().to_owned(), Vec::new()));
            line_index += 1;
        } else if trimmed.is_empty() {
            flush_paragraph(&mut blocks, &mut paragraph);
            line_index += 1;
        } else if trimmed.starts_with("$$") {
            flush_paragraph(&mut blocks, &mut paragraph);
            let mut text = trimmed.trim_start_matches("$$").to_owned();
            let closed = text.ends_with("$$") && text.len() > 2;
            if closed {
                text.truncate(text.len().saturating_sub(2));
                line_index += 1;
            } else {
                line_index += 1;
                while let Some(math_line) = lines.get(line_index).copied() {
                    if math_line.trim() == "$$" {
                        line_index += 1;
                        break;
                    }
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(math_line);
                    line_index += 1;
                }
            }
            blocks.push(MarkdownBlock::Math {
                display: true,
                text: text.trim().to_owned(),
            });
        } else if let Some((headers, alignments)) = table_header(&lines, line_index) {
            flush_paragraph(&mut blocks, &mut paragraph);
            line_index += 2;
            let mut rows = Vec::new();
            while let Some(row) = lines.get(line_index).copied() {
                if row.trim().is_empty() || !has_unescaped_pipe(row) {
                    break;
                }
                let Some(mut cells) = split_table_row(row) else {
                    break;
                };
                cells.resize(headers.len(), String::new());
                cells.truncate(headers.len());
                rows.push(cells);
                line_index += 1;
            }
            blocks.push(MarkdownBlock::Table {
                headers,
                rows,
                alignments,
            });
        } else if let Some((level, text)) = heading(trimmed) {
            flush_paragraph(&mut blocks, &mut paragraph);
            blocks.push(MarkdownBlock::Heading { level, text });
            line_index += 1;
        } else if is_rule(trimmed) {
            flush_paragraph(&mut blocks, &mut paragraph);
            blocks.push(MarkdownBlock::Rule);
            line_index += 1;
        } else if let Some(text) = trimmed
            .strip_prefix("> ")
            .or_else(|| trimmed.strip_prefix(">"))
        {
            flush_paragraph(&mut blocks, &mut paragraph);
            blocks.push(MarkdownBlock::Quote(text.trim().to_owned()));
            line_index += 1;
        } else if let Some(text) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            flush_paragraph(&mut blocks, &mut paragraph);
            blocks.push(MarkdownBlock::Bullet {
                checked: task_state(text).map(|(checked, _)| checked),
                text: task_text(text).to_owned(),
            });
            line_index += 1;
        } else if let Some((index, text)) = ordered_item(trimmed) {
            flush_paragraph(&mut blocks, &mut paragraph);
            blocks.push(MarkdownBlock::Ordered { index, text });
            line_index += 1;
        } else {
            paragraph.push(trimmed.to_owned());
            line_index += 1;
        }
    }

    if let Some((language, lines)) = code.take() {
        blocks.push(MarkdownBlock::Code {
            language,
            text: lines.join("\n"),
        });
    }
    flush_paragraph(&mut blocks, &mut paragraph);
    blocks
}

pub fn view(source: &str, raised: u32) -> impl IntoElement {
    let blocks = parse_markdown(source);
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .children(blocks.into_iter().map(|block| {
            match block {
                MarkdownBlock::Heading { level, text } => div()
                    .text_size(px(match level {
                        1 => 22.,
                        2 => 19.,
                        _ => 17.,
                    }))
                    .font_weight(gpui::FontWeight::BOLD)
                    .child(text),
                MarkdownBlock::Paragraph(text) => div().child(text),
                MarkdownBlock::Bullet { checked, text } => div().child(format!(
                    "{} {}",
                    checked
                        .map(|value| if value { "☑" } else { "☐" })
                        .unwrap_or("•"),
                    text
                )),
                MarkdownBlock::Ordered { index, text } => div().child(format!("{index}. {text}")),
                MarkdownBlock::Quote(text) => div()
                    .border_l_2()
                    .border_color(rgb(raised))
                    .pl(px(8.))
                    .child(text),
                MarkdownBlock::Code { language, text } => div()
                    .bg(rgb(raised))
                    .px(px(8.))
                    .py(px(6.))
                    .child(if language.is_empty() {
                        text
                    } else {
                        format!("[{language}]\n{text}")
                    }),
                MarkdownBlock::Math { display, text } => div()
                    .bg(rgb(raised))
                    .px(px(8.))
                    .py(px(6.))
                    .child(if display {
                        format!("[公式]\n{text}")
                    } else {
                        format!("[公式] {text}")
                    }),
                MarkdownBlock::Table {
                    headers,
                    rows,
                    alignments: _,
                } => div()
                    .flex()
                    .flex_col()
                    .children(std::iter::once(
                        div().flex().font_weight(gpui::FontWeight::BOLD).children(
                            headers
                                .into_iter()
                                .map(|cell| div().flex_1().px(px(6.)).py(px(4.)).child(cell)),
                        ),
                    ))
                    .children(rows.into_iter().map(|row| {
                        div().flex().children(
                            row.into_iter()
                                .map(|cell| div().flex_1().px(px(6.)).py(px(4.)).child(cell)),
                        )
                    })),
                MarkdownBlock::Rule => div().h(px(1.)).bg(rgb(raised)),
            }
        }))
}

fn table_header(lines: &[&str], index: usize) -> Option<(Vec<String>, Vec<TableAlignment>)> {
    let headers = split_table_row(*lines.get(index)?)?;
    let separator = *lines.get(index + 1)?;
    if !has_unescaped_pipe(lines[index]) {
        return None;
    }
    let separator_cells = split_table_row(separator)?;
    if headers.is_empty()
        || headers.len() != separator_cells.len()
        || separator_cells
            .iter()
            .any(|cell| parse_table_alignment(cell).is_none())
    {
        return None;
    }
    Some((
        headers,
        separator_cells
            .iter()
            .map(|cell| parse_table_alignment(cell).unwrap_or(TableAlignment::None))
            .collect(),
    ))
}

fn normalize_inline(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let rest = &text[cursor..];
        let Some(relative_start) = rest.find('[') else {
            output.push_str(rest);
            break;
        };
        let bracket_start = cursor + relative_start;
        let image = bracket_start > 0 && text.as_bytes()[bracket_start - 1] == b'!';
        let start = if image {
            bracket_start - 1
        } else {
            bracket_start
        };
        output.push_str(&text[cursor..start]);
        let label_start = bracket_start;
        let Some(label_end_relative) = text[label_start + 1..].find("](") else {
            output.push_str(&text[bracket_start..bracket_start + 1]);
            cursor = bracket_start + 1;
            continue;
        };
        let label_end = label_start + 1 + label_end_relative;
        let target_start = label_end + 2;
        let Some(target_end_relative) = text[target_start..].find(')') else {
            output.push_str(&text[bracket_start..bracket_start + 1]);
            cursor = bracket_start + 1;
            continue;
        };
        let target_end = target_start + target_end_relative;
        let label = &text[label_start + 1..label_end];
        let target = &text[target_start..target_end];
        if label.is_empty() || target.is_empty() {
            output.push_str(&text[bracket_start..bracket_start + 1]);
            cursor = bracket_start + 1;
            continue;
        }
        if image {
            output.push_str(&format!("[图片: {label}] ({target})"));
        } else {
            output.push_str(&format!("{label} ({target})"));
        }
        cursor = target_end + 1;
    }
    output
}

fn split_table_row(line: &str) -> Option<Vec<String>> {
    if !has_unescaped_pipe(line) {
        return None;
    }
    let mut value = line.trim();
    if value.starts_with('|') {
        value = &value[1..];
    }
    if value.ends_with('|') && !value.ends_with("\\|") {
        value = &value[..value.len() - 1];
    }

    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            cell.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '|' {
            cells.push(cell.trim().to_owned());
            cell.clear();
        } else {
            cell.push(character);
        }
    }
    if escaped {
        cell.push('\\');
    }
    cells.push(cell.trim().to_owned());
    Some(cells)
}

fn has_unescaped_pipe(line: &str) -> bool {
    let mut escaped = false;
    for character in line.chars() {
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '|' {
            return true;
        }
    }
    false
}

fn parse_table_alignment(cell: &str) -> Option<TableAlignment> {
    let cell = cell.trim();
    let left = cell.starts_with(':');
    let right = cell.ends_with(':');
    let start = usize::from(left);
    let end = cell.len().saturating_sub(usize::from(right));
    let dashes = cell.get(start..end)?;
    (dashes.len() >= 3 && dashes.chars().all(|character| character == '-')).then_some(
        match (left, right) {
            (true, true) => TableAlignment::Center,
            (true, false) => TableAlignment::Left,
            (false, true) => TableAlignment::Right,
            (false, false) => TableAlignment::None,
        },
    )
}

fn heading(line: &str) -> Option<(u8, String)> {
    let prefix = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    (1..=6).contains(&prefix).then(|| {
        (
            prefix as u8,
            line[prefix..]
                .trim()
                .trim_end_matches('#')
                .trim()
                .to_owned(),
        )
    })
}

fn ordered_item(line: &str) -> Option<(usize, String)> {
    let separator = line.find(". ")?;
    let index = line[..separator].parse().ok()?;
    Some((index, line[separator + 2..].trim().to_owned()))
}

fn task_state(text: &str) -> Option<(bool, &str)> {
    let marker = text.get(..3)?;
    matches!(marker, "[ ]" | "[x]" | "[X]").then(|| (marker != "[ ]", &text[3..]))
}

fn task_text(text: &str) -> &str {
    task_state(text)
        .map(|(_, value)| value.trim())
        .unwrap_or(text)
}

fn is_rule(line: &str) -> bool {
    line.len() >= 3
        && line
            .chars()
            .all(|character| matches!(character, '-' | '*' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_markdown_extensions() {
        assert!(is_markdown("README.MD"));
        assert!(is_markdown("notes.markdown"));
        assert!(!is_markdown("data.json"));
    }

    #[test]
    fn parses_headings_lists_tasks_quotes_and_code() {
        let blocks = parse_markdown(
            "# Title\n\n- [x] done\n- todo\n1. next\n> quote\n\n```rust\nfn main() {}\n```",
        );
        assert_eq!(
            blocks,
            vec![
                MarkdownBlock::Heading {
                    level: 1,
                    text: "Title".into()
                },
                MarkdownBlock::Bullet {
                    checked: Some(true),
                    text: "done".into()
                },
                MarkdownBlock::Bullet {
                    checked: None,
                    text: "todo".into()
                },
                MarkdownBlock::Ordered {
                    index: 1,
                    text: "next".into()
                },
                MarkdownBlock::Quote("quote".into()),
                MarkdownBlock::Code {
                    language: "rust".into(),
                    text: "fn main() {}".into()
                },
            ]
        );
    }

    #[test]
    fn joins_wrapped_paragraph_lines_and_flushes_unclosed_code() {
        assert_eq!(
            parse_markdown("one\ntwo"),
            vec![MarkdownBlock::Paragraph("one two".into())]
        );
        assert_eq!(
            parse_markdown("```text\nvalue"),
            vec![MarkdownBlock::Code {
                language: "text".into(),
                text: "value".into()
            }]
        );
    }

    #[test]
    fn parses_gfm_tables_and_alignments() {
        assert_eq!(
            parse_markdown(
                "before\n\n| Name | Count | Note | Empty |\n| :--- | :---: | ---: | --- |\n| one | 2 | right | |\n\nafter"
            ),
            vec![
                MarkdownBlock::Paragraph("before".into()),
                MarkdownBlock::Table {
                    headers: vec!["Name".into(), "Count".into(), "Note".into(), "Empty".into()],
                    rows: vec![vec!["one".into(), "2".into(), "right".into(), "".into()]],
                    alignments: vec![
                        TableAlignment::Left,
                        TableAlignment::Center,
                        TableAlignment::Right,
                        TableAlignment::None,
                    ],
                },
                MarkdownBlock::Paragraph("after".into()),
            ]
        );
    }

    #[test]
    fn parses_escaped_pipes_and_does_not_parse_code_as_table() {
        assert_eq!(
            parse_markdown("```text\n| raw | pipe |\n---\n```\n\n| A | B |\n| --- | --- |\n| left \\| right | value |"),
            vec![
                MarkdownBlock::Code {
                    language: "text".into(),
                    text: "| raw | pipe |\n---".into(),
                },
                MarkdownBlock::Table {
                    headers: vec!["A".into(), "B".into()],
                    rows: vec![vec!["left | right".into(), "value".into()]],
                    alignments: vec![TableAlignment::None, TableAlignment::None],
                },
            ]
        );
    }

    #[test]
    fn preserves_formula_source_and_exposes_inline_links_and_images() {
        assert_eq!(
            parse_markdown("See [docs](https://example.test) and ![diagram](images/a.png).\n\n$$\nx^2 + y^2 = z^2\n$$"),
            vec![
                MarkdownBlock::Paragraph(
                    "See docs (https://example.test) and [图片: diagram] (images/a.png).".into()
                ),
                MarkdownBlock::Math {
                    display: true,
                    text: "x^2 + y^2 = z^2".into(),
                },
            ]
        );
    }
}
