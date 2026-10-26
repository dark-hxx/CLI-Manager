//! Bounded, allowlisted Web projection. Source indexes intentionally include invisible rows.
use super::HistoryMessage;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPart {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<TranscriptPart>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts_truncated: Option<bool>,
}

pub(super) fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn clip(text: &str, limit: usize) -> String {
    let mut used = 0;
    text.chars()
        .take_while(|ch| {
            used += ch.len_utf16();
            used <= limit
        })
        .collect()
}

pub(super) fn project(
    id: &str,
    index: usize,
    message: &HistoryMessage,
) -> Option<TranscriptMessage> {
    if !matches!(message.role.as_str(), "user" | "assistant" | "tool") {
        return None;
    }
    let ordinary = |part: &&super::HistoryMessagePart| {
        message.role != "tool"
            && part.kind == "text"
            && part.tool_name.as_deref().unwrap_or_default().is_empty()
            && part.call_id.as_deref().unwrap_or_default().is_empty()
    };
    let text = message
        .parts
        .iter()
        .filter(ordinary)
        .map(|p| p.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let last_text = message.parts.iter().rposition(|p| ordinary(&p));
    let mut remaining = 8_000;
    let mut count = 0;
    let mut omitted = false;
    let mut parts = Vec::new();
    for (part_index, part) in message.parts.iter().enumerate() {
        if part.kind == "text" {
            if Some(part_index) == last_text && !text.trim().is_empty() {
                parts.push(TranscriptPart {
                    id: format!("{id}:{index}:part:{part_index}"),
                    kind: "text".into(),
                    text: clip(&text, 4_000),
                    truncated: units(&text) > 4_000,
                    tool_name: None,
                    call_id: None,
                });
            }
            continue;
        }
        if !matches!(
            part.kind.as_str(),
            "tool_call" | "tool_result" | "reasoning"
        ) || part.content.trim().is_empty()
        {
            continue;
        }
        if count >= 23 || remaining == 0 {
            omitted = true;
            continue;
        }
        count += 1;
        let visible = clip(&part.content, remaining.min(4_000));
        remaining -= units(&visible);
        parts.push(TranscriptPart {
            id: format!("{id}:{index}:part:{part_index}"),
            kind: part.kind.clone(),
            truncated: visible.len() < part.content.len(),
            text: visible,
            tool_name: part
                .tool_name
                .as_ref()
                .filter(|s| !s.is_empty())
                .map(|s| clip(s, 120)),
            call_id: part
                .call_id
                .as_ref()
                .filter(|s| !s.is_empty() && units(s) <= 256)
                .cloned(),
        });
    }
    if text.trim().is_empty() && parts.is_empty() {
        return None;
    }
    Some(TranscriptMessage {
        id: format!("{id}:{index}"),
        role: message.role.clone(),
        truncated: units(&text) > 4_000,
        text: clip(&text, 4_000),
        at: message
            .timestamp
            .as_ref()
            .filter(|s| !s.is_empty() && units(s) <= 64)
            .cloned(),
        model: message
            .model
            .as_ref()
            .filter(|s| !s.is_empty())
            .map(|s| clip(s, 256)),
        parts: Some(parts),
        parts_truncated: Some(omitted),
    })
}

pub(super) fn text_only(mut message: TranscriptMessage) -> Option<TranscriptMessage> {
    if message.role == "tool" || message.text.trim().is_empty() {
        return None;
    }
    message.parts = None;
    message.parts_truncated = None;
    Some(message)
}
