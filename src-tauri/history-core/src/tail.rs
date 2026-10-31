use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::Path;
use std::time::SystemTime;

/// 一份 JSONL 文件的增量读取状态。
///
/// 状态同时记录已消费的字节偏移、未完成的尾行和文件身份；文件被截断、替换或
/// 重新创建时会自动回退到文件开头，避免把新会话接到旧会话后面。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TailState {
    offset: u64,
    next_line_index: usize,
    pending: Vec<u8>,
    fingerprint: Option<FileFingerprint>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileFingerprint {
    len: u64,
    modified_ns: Option<u128>,
    identity: Option<u128>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct TailUpdate {
    pub reset: bool,
    pub lines: Vec<TailLine>,
    pub bytes_read: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct TailLine {
    pub index: usize,
    pub text: String,
}

impl TailState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn read_path(&mut self, path: impl AsRef<Path>) -> io::Result<TailUpdate> {
        let path = path.as_ref();
        let metadata = fs::metadata(path)?;
        let fingerprint = FileFingerprint::from_metadata(&metadata);
        let reset = self.should_reset(&metadata, &fingerprint);
        if reset {
            self.offset = 0;
            self.next_line_index = 0;
            self.pending.clear();
        }

        let mut file = File::open(path)?;
        if self.offset > 0 {
            use std::io::Seek;
            file.seek(std::io::SeekFrom::Start(self.offset))?;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        self.offset = metadata.len();
        self.fingerprint = Some(fingerprint);

        let bytes_read = bytes.len();
        self.pending.extend_from_slice(&bytes);
        let mut lines = Vec::new();
        let mut line_start = 0;
        for (index, byte) in self.pending.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            let mut line = self.pending[line_start..index].to_vec();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            lines.push(TailLine {
                index: self.next_line_index,
                text: String::from_utf8_lossy(&line).into_owned(),
            });
            self.next_line_index = self.next_line_index.saturating_add(1);
            line_start = index + 1;
        }
        if line_start > 0 {
            self.pending.drain(..line_start);
        }

        Ok(TailUpdate {
            reset,
            lines,
            bytes_read,
        })
    }

    fn should_reset(&self, metadata: &Metadata, fingerprint: &FileFingerprint) -> bool {
        let Some(previous) = &self.fingerprint else {
            return self.offset > metadata.len();
        };
        self.offset > metadata.len()
            || previous
                .identity
                .zip(fingerprint.identity)
                .is_some_and(|(before, after)| before != after)
            || (previous.modified_ns != fingerprint.modified_ns && self.offset == 0)
    }
}

impl FileFingerprint {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            len: metadata.len(),
            modified_ns: metadata.modified().ok().and_then(system_time_ns),
            identity: file_identity(metadata),
        }
    }
}

fn system_time_ns(time: SystemTime) -> Option<u128> {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}

#[cfg(unix)]
fn file_identity(metadata: &Metadata) -> Option<u128> {
    use std::os::unix::fs::MetadataExt;
    Some((u128::from(metadata.dev()) << 64) | u128::from(metadata.ino()))
}

#[cfg(windows)]
fn file_identity(_metadata: &Metadata) -> Option<u128> {
    // 稳定 Rust 版本尚未暴露 Windows 文件句柄身份字段；长度回退和 Unix 的
    // dev/inode 检查仍能覆盖截断与大多数替换场景，后续可在句柄 API 稳定后补齐。
    None
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_metadata: &Metadata) -> Option<u128> {
    None
}

#[cfg(test)]
mod tests {
    use super::TailState;
    use std::fs;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn reads_only_complete_lines_and_keeps_partial_tail() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"one\npart").unwrap();
        let mut state = TailState::new();
        let first = state.read_path(file.path()).unwrap();
        assert!(!first.reset);
        assert_eq!(first.lines[0].text, "one");
        assert_eq!(first.lines[0].index, 0);

        file.as_file_mut().write_all(b"ial\ntwo\r\n").unwrap();
        let second = state.read_path(file.path()).unwrap();
        assert_eq!(
            second
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            ["partial", "two"]
        );
        assert_eq!(second.lines[0].index, 1);
        assert_eq!(second.lines[1].index, 2);
    }

    #[test]
    fn skips_bad_json_at_call_site_without_blocking_later_lines() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"bad\n").unwrap();
        let mut state = TailState::new();
        let first = state.read_path(file.path()).unwrap();
        assert_eq!(first.lines.len(), 1);
        file.as_file_mut()
            .write_all(
                br#"{"ok":true}
"#,
            )
            .unwrap();
        let second = state.read_path(file.path()).unwrap();
        assert_eq!(second.lines[0].text, r#"{"ok":true}"#);
    }

    #[test]
    fn resets_after_truncation_and_restarts_line_indices() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"old\ncontent\n").unwrap();
        let mut state = TailState::new();
        state.read_path(file.path()).unwrap();
        fs::write(file.path(), b"new\n").unwrap();
        let update = state.read_path(file.path()).unwrap();
        assert!(update.reset);
        assert_eq!(update.lines[0].text, "new");
        assert_eq!(update.lines[0].index, 0);
    }

    #[test]
    fn repeated_poll_without_append_is_empty() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"one\n").unwrap();
        let mut state = TailState::new();
        state.read_path(file.path()).unwrap();
        let update = state.read_path(file.path()).unwrap();
        assert!(update.lines.is_empty());
        assert_eq!(update.bytes_read, 0);
    }
}
