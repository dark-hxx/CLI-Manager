//! 終端控制序列：純文字版去掉所有控制序列；帶樣式的版本只留白名單內的 SGR。

use crate::event::STYLED_BYTES;
use std::{iter::Peekable, str::Chars};

/// 去除終端控制序列（CSI、OSC、DCS 等）與其他控制字元，只保留換行與定位字元。
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\u{1b}' => match chars.next() {
                Some('[') => skip_csi(&mut chars),
                Some(']') => skip_string(&mut chars, true),
                Some('P' | 'X' | '^' | '_') => skip_string(&mut chars, false),
                // 字元集選擇等：中介字元之後還有一個結尾字元。
                Some(' '..='/') => {
                    while chars.next_if(|next| (' '..='/').contains(next)).is_some() {}
                    chars.next();
                }
                _ => {}
            },
            '\u{9b}' => skip_csi(&mut chars),
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\n' | '\t' => out.push(character),
            other if other.is_control() => {}
            other => out.push(other),
        }
    }
    out
}

/// 略過一個 CSI 序列的參數與結尾字元。
fn skip_csi(chars: &mut Peekable<Chars>) {
    for character in chars.by_ref() {
        if ('\u{40}'..='\u{7e}').contains(&character) {
            break;
        }
    }
}

/// 略過 OSC、DCS 等字串序列：以 ST（`ESC \`）結束，OSC 也接受 BEL。
fn skip_string(chars: &mut Peekable<Chars>, bell_ends: bool) {
    while let Some(character) = chars.next() {
        if bell_ends && character == '\u{7}' {
            break;
        }
        if character == '\u{1b}' {
            chars.next_if_eq(&'\\');
            break;
        }
    }
}

/// 終端輸出的一小段：可見字元，或整理過的 SGR 參數（例如 `38;5;140`）。
enum Piece {
    Char(char),
    Sgr(String),
}

/// 保留顏色與粗細的終端輸出（例如 `/context` 的彩色格子）：其他控制序列照 `strip_ansi`
/// 去掉；SGR 只留白名單內的參數並改寫成標準寫法 `ESC [ 參數 m`，網頁照參數上色，不會
/// 把任何文字當成 HTML。去掉開頭的空行與結尾的空白，但保留第一行的縮排（欄位才對得齊），
/// 最多 `max` 個可見字元。完全沒有樣式時傳回 None，網頁改用純文字。
pub(crate) fn styled_output(text: &str, max: usize) -> Option<String> {
    let mut pieces = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\u{1b}' => match chars.next() {
                Some('[') => pieces.extend(read_sgr(&mut chars).map(Piece::Sgr)),
                Some(']') => skip_string(&mut chars, true),
                Some('P' | 'X' | '^' | '_') => skip_string(&mut chars, false),
                Some(' '..='/') => {
                    while chars.next_if(|next| (' '..='/').contains(next)).is_some() {}
                    chars.next();
                }
                _ => {}
            },
            '\u{9b}' => pieces.extend(read_sgr(&mut chars).map(Piece::Sgr)),
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    pieces.push(Piece::Char('\n'));
                }
            }
            '\n' | '\t' => pieces.push(Piece::Char(character)),
            other if other.is_control() => {}
            other => pieces.push(Piece::Char(other)),
        }
    }
    if !pieces
        .iter()
        .any(|piece| matches!(piece, Piece::Sgr(params) if params != "0"))
    {
        return None;
    }
    // 開頭的空行不要；第一個有字的行連同縮排一起保留（空白與樣式維持原本的順序）。
    let mut kept = Vec::with_capacity(pieces.len());
    let mut line = Vec::new();
    let mut started = false;
    for piece in pieces {
        if started {
            kept.push(piece);
            continue;
        }
        match piece {
            // 空行：空白丟掉，樣式留著（後面的字還要用）。
            Piece::Char('\n') => kept.extend(
                line.drain(..)
                    .filter(|piece| matches!(piece, Piece::Sgr(_))),
            ),
            Piece::Char(character) if character.is_whitespace() => line.push(piece),
            Piece::Sgr(_) => line.push(piece),
            Piece::Char(_) => {
                started = true;
                kept.append(&mut line);
                kept.push(piece);
            }
        }
    }
    // 結尾的空白與收尾的重設都不必留。
    while let Some(last) = kept.last() {
        match last {
            Piece::Char(character) if !character.is_whitespace() => break,
            _ => {
                kept.pop();
            }
        }
    }
    let mut out = String::new();
    let mut count = 0;
    for piece in &kept {
        match piece {
            Piece::Sgr(params) => {
                out.push_str("\u{1b}[");
                out.push_str(params);
                out.push('m');
            }
            Piece::Char(character) => {
                if count == max {
                    out.push_str("\u{1b}[0m…");
                    break;
                }
                count += 1;
                out.push(*character);
            }
        }
    }
    (count > 0 && out.len() <= STYLED_BYTES).then_some(out)
}

/// 讀完一個 CSI 序列；是 SGR（結尾為 `m`）就傳回整理過的參數，其他序列（游標移動、清畫面、
/// 私有模式等）與整理後沒有參數的 SGR 傳回 None。
fn read_sgr(chars: &mut Peekable<Chars>) -> Option<String> {
    let mut raw = String::new();
    let mut plain = true;
    for character in chars.by_ref() {
        match character {
            '0'..='9' | ';' | ':' if raw.len() < 96 => raw.push(character),
            '\u{40}'..='\u{7e}' => {
                return if plain && character == 'm' {
                    sgr_params(&raw)
                } else {
                    None
                };
            }
            // 私有標記（`?`、`>`…）、中介字元或過長的參數：不是要保留的 SGR。
            _ => plain = false,
        }
    }
    None
}

/// SGR 參數的白名單：重設、粗體、淡色、斜體、底線、反白、刪除線與各自的關閉，16 色、
/// 256 色、24 位元的前景與背景色。數值超出範圍或不認得的參數略過；冒號子參數
/// （`38:2::r:g:b`、`4:3`）也改寫成分號的寫法。
fn sgr_params(raw: &str) -> Option<String> {
    let number = |text: &str| -> Option<u16> {
        if text.is_empty() {
            Some(0)
        } else {
            text.parse::<u16>().ok()
        }
    };
    let color = |base: u16, values: &[Option<u16>]| -> Option<String> {
        match values {
            [Some(5), Some(index), ..] if *index <= 255 => Some(format!("{base};5;{index}")),
            [Some(2), Some(red), Some(green), Some(blue), ..]
                if *red <= 255 && *green <= 255 && *blue <= 255 =>
            {
                Some(format!("{base};2;{red};{green};{blue}"))
            }
            _ => None,
        }
    };
    let mut kept: Vec<String> = Vec::new();
    let groups: Vec<&str> = raw.split(';').collect();
    let mut index = 0;
    while index < groups.len() {
        let group = groups[index];
        index += 1;
        if group.contains(':') {
            let parts: Vec<&str> = group.split(':').collect();
            match number(parts[0]) {
                Some(code @ (38 | 48)) => {
                    // ITU 的寫法在 2 後面多一個色彩空間欄位：38:2:<空間>:r:g:b。
                    let mut values: Vec<Option<u16>> =
                        parts[1..].iter().map(|part| number(part)).collect();
                    if values.first() == Some(&Some(2)) && values.len() >= 5 {
                        values.remove(1);
                    }
                    kept.extend(color(code, &values));
                }
                // 4:0 是關掉底線，其他（波浪、雙底線…）一律畫成一般底線。
                Some(4) => kept.push(if parts.get(1).and_then(|part| number(part)) == Some(0) {
                    "24".into()
                } else {
                    "4".into()
                }),
                _ => {}
            }
            continue;
        }
        let Some(code) = number(group) else {
            continue;
        };
        match code {
            0..=4 | 7 | 9 | 22..=24 | 27 | 29 | 30..=37 | 39..=47 | 49 | 90..=97 | 100..=107 => {
                kept.push(code.to_string())
            }
            38 | 48 => {
                let values: Vec<Option<u16>> = groups[index..]
                    .iter()
                    .take(4)
                    .map(|part| number(part))
                    .collect();
                let used = match values.first() {
                    Some(Some(5)) => 2,
                    Some(Some(2)) => 4,
                    _ => values.len(),
                };
                index += used;
                kept.extend(color(code, &values));
            }
            _ => {}
        }
    }
    (!kept.is_empty()).then(|| kept.join(";"))
}
