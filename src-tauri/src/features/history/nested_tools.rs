//! Conservative lexical call-site extraction, never a JavaScript evaluator.
use super::{make_tool_event, HistoryToolEvent};
use super::types::HistoryToolEvidence;

fn ident(byte: u8) -> bool { byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$') }

fn skip_space(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() { i += 1; }
    i
}

fn quoted_end(bytes: &[u8], mut i: usize) -> usize {
    let quote = bytes[i];
    i += 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' { i = (i + 2).min(bytes.len()); continue; }
        if bytes[i] == quote { return i + 1; }
        i += 1;
    }
    i
}

pub(super) fn literal_tool_calls(script: &str) -> Vec<(usize, String)> {
    // Oversized scripts are not partially interpreted. Native calls remain visible.
    if script.len() > 512 * 1024 { return Vec::new(); }
    let bytes = script.as_bytes();
    let mut calls = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if matches!(bytes[i], b'\'' | b'"' | b'`') { i = quoted_end(bytes, i); continue; }
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' { i += 1; }
            continue;
        }
        if bytes[i..].starts_with(b"/*") {
            i += 2;
            while i + 1 < bytes.len() && !bytes[i..].starts_with(b"*/") { i += 1; }
            i = (i + 2).min(bytes.len());
            continue;
        }
        // Regex/division syntax is ambiguous without a full parser: omit inferred
        // sites for this script rather than interpreting text in a regex as a call.
        if bytes[i] == b'/' { return Vec::new(); }
        if !bytes[i..].starts_with(b"tools") || (i > 0 && (ident(bytes[i - 1]) || bytes[i - 1] == b'.')) {
            i += 1; continue;
        }
        let start = i;
        i += 5;
        let mut cursor = skip_space(bytes, i);
        let name;
        if bytes.get(cursor) == Some(&b'.') {
            cursor = skip_space(bytes, cursor + 1);
            let from = cursor;
            while cursor < bytes.len() && ident(bytes[cursor]) { cursor += 1; }
            name = &script[from..cursor];
        } else if bytes.get(cursor) == Some(&b'[') {
            cursor = skip_space(bytes, cursor + 1);
            if !matches!(bytes.get(cursor), Some(b'\'' | b'"')) { continue; }
            let from = cursor + 1;
            let end = quoted_end(bytes, cursor);
            if end <= from || !matches!(bytes.get(end - 1), Some(b'\'' | b'"')) { continue; }
            name = &script[from..end - 1];
            cursor = skip_space(bytes, end);
            if bytes.get(cursor) != Some(&b']') { continue; }
            cursor += 1;
        } else { continue; }
        cursor = skip_space(bytes, cursor);
        if !name.is_empty() && name.bytes().all(ident) && bytes.get(cursor) == Some(&b'(') {
            calls.push((start, name.to_string()));
            if calls.len() == 4096 { return Vec::new(); }
        }
    }
    calls
}

pub(super) fn append_nested_tools(script: &str, parent: &HistoryToolEvent, events: &mut Vec<HistoryToolEvent>) {
    let Some(parent_id) = parent.call_id.as_deref() else { return };
    for (position, name) in literal_tool_calls(script) {
        let id = format!("{parent_id}:inferred:{position}");
        if events.iter().any(|event| event.call_id.as_deref() == Some(&id)) { continue; }
        let mut event = make_tool_event(Some(id), &name, parent.message_index,
            parent.timestamp.clone(), None, None, None, None, None);
        event.evidence = Some(HistoryToolEvidence {
            kind: "inferred".to_string(), parent_call_id: Some(parent_id.to_string()), source_position: Some(position),
        });
        events.push(event);
    }
}
