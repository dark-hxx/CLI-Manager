//! Claude Code 與 Codex 的解析共用的文字工具：截斷、時間、JSON 欄位、路徑與終端控制序列。

mod ansi;
#[cfg(test)]
mod tests;

pub use ansi::strip_ansi;
pub(crate) use ansi::styled_output;

use crate::event::SUMMARY_TEXT;
use serde_json::Value;

/// 保留開頭最多 `max` 個字元，截斷時補上「…」。
pub fn keep_head(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((index, _)) => format!("{}…", &text[..index]),
        None => text.to_string(),
    }
}

/// 保留結尾最多 `max` 個字元，截斷時在前面補上「…」。
pub fn keep_tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    match text.char_indices().nth(count - max) {
        Some((index, _)) => format!("…{}", &text[index..]),
        None => text.to_string(),
    }
}

/// 去除 Claude Code 插入的 `<system-reminder>` 區段並修剪空白。
pub fn strip_reminders(text: &str) -> String {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        rest = match rest[start..].find(CLOSE) {
            Some(end) => &rest[start + end + CLOSE.len()..],
            None => "",
        };
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// 在工作目錄內的路徑改為相對路徑，手機上比較好讀。
pub(crate) fn relative(path: &str, cwd: Option<&str>) -> String {
    if let Some(cwd) = cwd
        .map(|cwd| cwd.trim_end_matches('/'))
        .filter(|cwd| !cwd.is_empty())
    {
        if path == cwd {
            return ".".into();
        }
        if let Some(rest) = path
            .strip_prefix(cwd)
            .and_then(|rest| rest.strip_prefix('/'))
            .filter(|rest| !rest.is_empty())
        {
            return rest.into();
        }
    }
    path.into()
}

/// 第一個非空白的行（去掉前後空白）；全是空白時為空字串。
pub(crate) fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .into()
}

/// 物件裡第一個單行、不超過摘要長度的字串值；沒有時為空字串（不認得的工具以它當摘要）。
pub(crate) fn first_short_string(input: &Value) -> String {
    input
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(_, value)| value.as_str())
        .map(str::trim)
        .find(|value| {
            !value.is_empty() && !value.contains('\n') && value.chars().count() <= SUMMARY_TEXT
        })
        .unwrap_or_default()
        .into()
}

/// 合併標準輸出與標準錯誤（各自去掉結尾空白），兩者都有時以換行分隔。
pub(crate) fn join_output(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim_end();
    let stderr = stderr.trim_end();
    match (stdout.is_empty(), stderr.is_empty()) {
        (_, true) => stdout.into(),
        (true, false) => stderr.into(),
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

/// 非負整數；浮點數四捨五入，負數、非有限值與其他型別為 `None`。
pub(crate) fn number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.is_finite() && *number >= 0.0)
            .map(|number| number.round() as u64)
    })
}

/// 物件欄位裡去掉前後空白後非空的字串。
pub(crate) fn text_field(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(String::from)
}

/// 解析 RFC 3339 時間（含小數秒與 Z/±hh:mm 時區），傳回 Unix 毫秒。
pub fn parse_timestamp(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    let digits = |from: usize, to: usize| -> Option<i64> {
        let slice = bytes.get(from..to)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(
            slice
                .iter()
                .fold(0i64, |value, digit| value * 10 + i64::from(digit - b'0')),
        )
    };
    let separators = bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && matches!(bytes.get(10), Some(b'T' | b't' | b' '))
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':');
    if !separators {
        return None;
    }
    let (year, month, day) = (digits(0, 4)?, digits(5, 7)?, digits(8, 10)?);
    let (hour, minute, second) = (digits(11, 13)?, digits(14, 16)?, digits(17, 19)?);
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut index = 19;
    let mut millis = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
        // 小數秒只取前三位，不足三位時補 0，得到毫秒。
        millis = bytes[start..index]
            .iter()
            .chain(std::iter::repeat(&b'0'))
            .take(3)
            .fold(0, |value, digit| value * 10 + i64::from(digit - b'0'));
    }
    let offset = match bytes.get(index) {
        Some(b'Z' | b'z') => {
            index += 1;
            0
        }
        Some(&sign @ (b'+' | b'-')) => {
            let hours = digits(index + 1, index + 3)?;
            let (minutes, end) = if bytes.get(index + 3) == Some(&b':') {
                (digits(index + 4, index + 6)?, index + 6)
            } else {
                (digits(index + 3, index + 5)?, index + 5)
            };
            if hours > 23 || minutes > 59 {
                return None;
            }
            index = end;
            let seconds = hours * 3600 + minutes * 60;
            if sign == b'+' {
                seconds
            } else {
                -seconds
            }
        }
        _ => return None,
    };
    if index != bytes.len() {
        return None;
    }
    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    u64::try_from(seconds.checked_mul(1000)? + millis).ok()
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 公曆日期距 1970-01-01 的天數（Howard Hinnant 的演算法）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
