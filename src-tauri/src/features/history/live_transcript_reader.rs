use super::live_transcript_projection::{project, text_only, TranscriptMessage};
use super::{
    extract_cwd, extract_model, extract_reasoning_effort, extract_session_meta_id,
    is_synthetic_model, normalize_history_path, parse_message, qualify_model_with_reasoning_effort,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::fs::{File, Metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

const MAX_LINE: usize = 8 * 1024 * 1024;
const CACHE_BYTES: usize = 1024 * 1024;
const PAGE_BYTES: usize = 512 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    pub len: u64,
    pub modified: Option<SystemTime>,
    pub created: Option<SystemTime>,
}
impl From<&Metadata> for Stamp {
    fn from(meta: &Metadata) -> Self {
        Self {
            len: meta.len(),
            modified: meta.modified().ok(),
            created: meta.created().ok(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub cli_session_id: String,
    pub revision: String,
    pub epoch: String,
    pub unchanged: bool,
    pub start: usize,
    pub total: usize,
    pub messages: Vec<TranscriptMessage>,
}

pub(super) struct Reader {
    pub id: String,
    pub cwd: String,
    pub offset: u64,
    pub stamp: Option<Stamp>,
    pub epoch: String,
    pending: Vec<u8>,
    model: Option<String>,
    identity: Option<String>,
    project: Option<String>,
    total: usize,
    ring: VecDeque<(usize, Option<TranscriptMessage>, usize)>,
    bytes: usize,
    // Detect replacement/overwrite around the old EOF even when the file grows.
    boundary: Vec<u8>,
    prefix: Vec<u8>,
    committed_tail: bool,
    pub read_bytes: u64,
    pub probe_bytes: u64,
}
impl Reader {
    pub fn new(id: &str, cwd: &str) -> Self {
        Self {
            id: id.into(),
            cwd: normalize_history_path(cwd),
            offset: 0,
            stamp: None,
            epoch: uuid::Uuid::new_v4().to_string(),
            pending: Vec::new(),
            model: None,
            identity: None,
            project: None,
            total: 0,
            ring: VecDeque::new(),
            bytes: 0,
            boundary: Vec::new(),
            prefix: Vec::new(),
            committed_tail: false,
            read_bytes: 0,
            probe_bytes: 0,
        }
    }

    fn line(&mut self, raw: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(raw) else {
            return;
        };
        if self.identity.is_none() {
            self.identity = extract_session_meta_id(&value).or_else(|| {
                value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        }
        if self.project.is_none() {
            self.project = extract_cwd(&value).map(|cwd| normalize_history_path(&cwd));
        }
        if let Some(model) = extract_model(&value).filter(|m| !is_synthetic_model(m)) {
            self.model = Some(qualify_model_with_reasoning_effort(
                model,
                extract_reasoning_effort(&value).as_deref(),
            ));
        }
        let Some(mut message) = parse_message(&value) else {
            return;
        };
        if message.model.is_none() && message.role == "assistant" {
            message.model = self.model.clone();
        }
        let projected = project(&self.id, self.total, &message);
        let bytes = projected
            .as_ref()
            .map(|p| serde_json::to_vec(p).unwrap().len())
            .unwrap_or(0);
        self.ring.push_back((self.total, projected, bytes));
        self.total += 1;
        self.bytes += bytes;
        while self.ring.len() > 40 || self.bytes > CACHE_BYTES {
            if let Some((_, _, size)) = self.ring.pop_front() {
                self.bytes -= size;
            }
        }
    }

    pub fn update(&mut self, path: &Path, stop: Option<usize>) -> Result<bool, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let stamp = Stamp::from(&file.metadata().map_err(|e| e.to_string())?);
        if stop.is_none() && self.stamp.as_ref() == Some(&stamp) {
            return Ok(false);
        }
        let mut reset = self.stamp.as_ref().is_some_and(|old| {
            stamp.created != old.created
                || stamp.len < self.offset
                || (stamp.len == old.len && stamp.modified != old.modified)
        });
        if !reset && self.offset > 0 {
            let mut head = vec![0; self.prefix.len()];
            self.probe_bytes += head.len() as u64;
            if file.read_exact(&mut head).is_err() || head != self.prefix {
                reset = true;
            }
            file.seek(SeekFrom::Start(self.offset - self.boundary.len() as u64))
                .map_err(|e| e.to_string())?;
            let mut tail = vec![0; self.boundary.len()];
            self.probe_bytes += tail.len() as u64;
            if file.read_exact(&mut tail).is_err() || tail != self.boundary {
                reset = true;
            }
        }
        if reset {
            *self = Self::new(&self.id, &self.cwd);
        }
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        if self.committed_tail && stamp.len > self.offset {
            let mut byte = [0];
            file.read_exact(&mut byte).map_err(|e| e.to_string())?;
            if matches!(byte[0], b'\n' | b'\r') {
                self.offset += 1;
                self.read_bytes += 1;
                if self.prefix.len() < 256 {
                    self.prefix.push(byte[0]);
                }
                self.boundary.push(byte[0]);
                if self.boundary.len() > 64 {
                    self.boundary.remove(0);
                }
                self.committed_tail = false;
            } else {
                // A previously valid no-newline tail was extended, not a new record.
                *self = Self::new(&self.id, &self.cwd);
                file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
            }
        }
        // A snapshot has a fixed EOF; a busy CLI cannot keep this request open forever.
        let mut input =
            BufReader::with_capacity(64 * 1024, file.take(stamp.len.saturating_sub(self.offset)));
        loop {
            let chunk = input.fill_buf().map_err(|e| e.to_string())?;
            if chunk.is_empty() {
                break;
            }
            let size = chunk
                .iter()
                .position(|b| *b == b'\n')
                .map_or(chunk.len(), |n| n + 1);
            if self.pending.len() + size > MAX_LINE {
                return Err("transcript_record_too_large".into());
            }
            self.pending.extend_from_slice(&chunk[..size]);
            self.offset += size as u64;
            self.read_bytes += size as u64;
            if self.prefix.len() < 256 {
                self.prefix
                    .extend_from_slice(&chunk[..size.min(256 - self.prefix.len())]);
            }
            self.boundary.extend_from_slice(&chunk[..size]);
            if self.boundary.len() > 64 {
                self.boundary.drain(..self.boundary.len() - 64);
            }
            let complete = self.pending.last() == Some(&b'\n');
            input.consume(size);
            if complete {
                let raw = std::mem::take(&mut self.pending);
                self.line(&raw);
                if stop.is_some_and(|end| self.total >= end) {
                    break;
                }
            }
        }
        if !self.pending.is_empty() && serde_json::from_slice::<Value>(&self.pending).is_ok() {
            let raw = std::mem::take(&mut self.pending);
            self.line(&raw);
            self.committed_tail = true;
        }
        self.stamp = Some(stamp);
        Ok(true)
    }

    pub fn page(
        &self,
        before: Option<usize>,
        detailed: bool,
        revision: Option<&str>,
    ) -> TranscriptPage {
        let revision_now = format!("{}:{}", self.epoch, self.total);
        let available = self.identity.as_deref() == Some(&self.id)
            && self.project.as_deref() == Some(&self.cwd);
        let unchanged = available && before.is_none() && revision == Some(&revision_now);
        let end = before.unwrap_or(self.total).min(self.total);
        let mut start = end;
        let mut messages = Vec::new();
        let mut bytes = 1024;
        if available && !unchanged {
            for (index, entry, _) in self.ring.iter().rev().filter(|(i, _, _)| *i < end).take(40) {
                let entry = entry
                    .clone()
                    .and_then(|m| if detailed { Some(m) } else { text_only(m) });
                if let Some(message) = entry {
                    let size = serde_json::to_vec(&message).unwrap().len() + 1;
                    if bytes + size > PAGE_BYTES {
                        break;
                    }
                    bytes += size;
                    messages.push(message);
                }
                start = *index;
            }
            messages.reverse();
        }
        TranscriptPage {
            available,
            reason: (!available).then(|| "missing".into()),
            cli_session_id: self.id.clone(),
            revision: revision_now,
            epoch: self.epoch.clone(),
            unchanged,
            start,
            total: self.total,
            messages,
        }
    }

    pub fn older(
        &self,
        path: &Path,
        before: usize,
        detailed: bool,
    ) -> Result<TranscriptPage, String> {
        let mut replay = Self::new(&self.id, &self.cwd);
        replay.update(path, Some(before.min(self.total)))?;
        let mut page = replay.page(Some(before.min(self.total)), detailed, None);
        page.total = self.total;
        page.epoch = self.epoch.clone();
        page.revision = format!("{}:{}", self.epoch, self.total);
        Ok(page)
    }
}
