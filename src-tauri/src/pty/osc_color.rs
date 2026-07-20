use std::fmt::Write as _;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalColors {
    pub foreground: [u8; 3],
    pub background: [u8; 3],
}

pub struct OscColorFilterResult {
    pub output: Vec<u8>,
    pub reply: Vec<u8>,
}

pub fn parse_hex_rgb(value: &str) -> Option<[u8; 3]> {
    let hex = value.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some([
        u8::from_str_radix(&hex[0..2], 16).ok()?,
        u8::from_str_radix(&hex[2..4], 16).ok()?,
        u8::from_str_radix(&hex[4..6], 16).ok()?,
    ])
}

pub fn filter_color_queries(
    data: &[u8],
    colors: Option<TerminalColors>,
    reply_enabled: bool,
) -> Option<OscColorFilterResult> {
    let mut cursor = 0;
    let mut copied_until = 0;
    let mut output: Option<Vec<u8>> = None;
    let mut reply = Vec::new();

    while cursor + 2 <= data.len() {
        let Some(relative_start) = data[cursor..].windows(2).position(|part| part == b"\x1b]")
        else {
            break;
        };
        let start = cursor + relative_start;
        let Some((terminator_index, terminator_len)) = find_osc_terminator(data, start + 2) else {
            break;
        };
        let body = &data[start + 2..terminator_index];
        let query_id = match body {
            b"10;?" => Some(10),
            b"11;?" => Some(11),
            _ => None,
        };
        let sequence_end = terminator_index + terminator_len;
        if let Some(query_id) = query_id {
            let filtered = output.get_or_insert_with(|| Vec::with_capacity(data.len()));
            filtered.extend_from_slice(&data[copied_until..start]);
            copied_until = sequence_end;
            if reply_enabled {
                if let Some(colors) = colors {
                    append_color_reply(&mut reply, query_id, colors);
                }
            }
        }
        cursor = sequence_end;
    }

    output.map(|mut output| {
        output.extend_from_slice(&data[copied_until..]);
        OscColorFilterResult { output, reply }
    })
}

fn find_osc_terminator(data: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut index = from;
    while index < data.len() {
        match data[index] {
            0x07 => return Some((index, 1)),
            0x1b if data.get(index + 1) == Some(&b'\\') => return Some((index, 2)),
            _ => index += 1,
        }
    }
    None
}

fn append_color_reply(reply: &mut Vec<u8>, query_id: u8, colors: TerminalColors) {
    let rgb = if query_id == 10 {
        colors.foreground
    } else {
        colors.background
    };
    let mut sequence = String::with_capacity(32);
    let _ = write!(
        sequence,
        "\x1b]{query_id};rgb:{0:02X}{0:02X}/{1:02X}{1:02X}/{2:02X}{2:02X}\x1b\\",
        rgb[0], rgb[1], rgb[2]
    );
    reply.extend_from_slice(sequence.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::boundary::safe_emit_boundary;

    const COLORS: TerminalColors = TerminalColors {
        foreground: [0xd3, 0xd7, 0xcf],
        background: [0x00, 0x00, 0x00],
    };

    #[test]
    fn parses_strict_hex_rgb() {
        assert_eq!(parse_hex_rgb("#D3D7CF"), Some([0xd3, 0xd7, 0xcf]));
        assert_eq!(parse_hex_rgb("D3D7CF"), None);
        assert_eq!(parse_hex_rgb("#fff"), None);
        assert_eq!(parse_hex_rgb("#GG0000"), None);
    }

    #[test]
    fn removes_queries_and_builds_one_ordered_reply() {
        let data = b"before\x1b]10;?\x1b\\\x1b]11;?\x07after";
        let result = filter_color_queries(data, Some(COLORS), true).unwrap();
        assert_eq!(result.output, b"beforeafter");
        assert_eq!(
            result.reply,
            b"\x1b]10;rgb:D3D3/D7D7/CFCF\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\"
        );
    }

    #[test]
    fn ssh_mode_consumes_queries_without_replying() {
        let result = filter_color_queries(b"\x1b]11;?\x1b\\prompt", Some(COLORS), false).unwrap();
        assert_eq!(result.output, b"prompt");
        assert!(result.reply.is_empty());
    }

    #[test]
    fn missing_colors_consumes_queries_without_replying() {
        let result = filter_color_queries(b"\x1b]10;?\x07", None, true).unwrap();
        assert!(result.output.is_empty());
        assert!(result.reply.is_empty());
    }

    #[test]
    fn leaves_other_and_incomplete_osc_sequences_unchanged() {
        assert!(
            filter_color_queries(b"\x1b]8;;https://example.com\x1b\\link", Some(COLORS), true)
                .is_none()
        );
        assert!(filter_color_queries(b"\x1b]10;?", Some(COLORS), true).is_none());
        assert!(
            filter_color_queries(b"\x1b]10;rgb:ffff/ffff/ffff\x07", Some(COLORS), true).is_none()
        );
    }

    #[test]
    fn boundary_buffering_handles_every_query_split_point() {
        let original = b"before\x1b]10;?\x1b\\after";
        for split_at in 0..=original.len() {
            let mut pending = original[..split_at].to_vec();
            let mut visible = Vec::new();
            let mut reply = Vec::new();
            let first_safe = safe_emit_boundary(&pending);
            if let Some(filtered) = filter_color_queries(&pending[..first_safe], Some(COLORS), true)
            {
                visible.extend_from_slice(&filtered.output);
                reply.extend_from_slice(&filtered.reply);
            } else {
                visible.extend_from_slice(&pending[..first_safe]);
            }
            pending.drain(..first_safe);
            pending.extend_from_slice(&original[split_at..]);

            let second_safe = safe_emit_boundary(&pending);
            let safe_output = &pending[..second_safe];
            if let Some(filtered) = filter_color_queries(safe_output, Some(COLORS), true) {
                visible.extend_from_slice(&filtered.output);
                reply.extend_from_slice(&filtered.reply);
            } else {
                visible.extend_from_slice(safe_output);
            }

            assert_eq!(visible, b"beforeafter", "split_at={split_at}");
            assert_eq!(
                reply, b"\x1b]10;rgb:D3D3/D7D7/CFCF\x1b\\",
                "split_at={split_at}",
            );
        }
    }
}
