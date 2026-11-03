use std::time::SystemTime;

const MAX_SAMPLES: usize = 8192;

/** A private-file seek hint, never an authority for replay contents. */
pub(super) struct SpoolCursorIndex {
    samples: Vec<(u64, u64)>,
    frames: usize,
    stride: usize,
    last_sequence: u64,
    bytes: u64,
    modified: Option<SystemTime>,
    ordered: bool,
}

impl Default for SpoolCursorIndex {
    fn default() -> Self {
        Self {
            samples: Vec::new(),
            frames: 0,
            stride: 128,
            last_sequence: 0,
            bytes: 0,
            modified: None,
            ordered: true,
        }
    }
}

impl SpoolCursorIndex {
    pub(super) fn append(
        &mut self,
        sequence: u64,
        offset: u64,
        end: u64,
        modified: Option<SystemTime>,
    ) {
        if offset != self.bytes || (self.frames > 0 && sequence <= self.last_sequence) {
            self.ordered = false;
        }
        if self.ordered && self.frames % self.stride == 0 {
            if self.samples.len() >= MAX_SAMPLES {
                let mut i = 0;
                self.samples.retain(|_| {
                    let keep = i % 2 == 0;
                    i += 1;
                    keep
                });
                self.stride = self.stride.saturating_mul(2);
            }
            if self.frames % self.stride == 0 {
                self.samples.push((sequence, offset));
            }
        }
        self.frames += 1;
        self.last_sequence = sequence;
        self.bytes = end;
        self.modified = modified;
    }

    pub(super) fn set_modified(&mut self, modified: Option<SystemTime>) {
        self.modified = modified;
    }

    pub(super) fn seek_offset(&self, after: u64, bytes: u64, modified: Option<SystemTime>) -> u64 {
        if !self.ordered || self.frames == 0 || self.bytes != bytes || self.modified != modified {
            return 0;
        }
        if after >= self.last_sequence {
            return bytes;
        }
        // A sample at after+1 is the first pending frame, so it is safe to seek
        // there instead of rescanning an entire preceding block at its boundary.
        let i = self
            .samples
            .partition_point(|(sequence, _)| *sequence <= after.saturating_add(1));
        i.checked_sub(1).map_or(0, |i| self.samples[i].1)
    }

    pub(super) fn resident_bytes(&self) -> usize {
        self.samples.capacity() * std::mem::size_of::<(u64, u64)>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_index_never_skips_cursor_suffix_and_is_bounded() {
        let mut index = SpoolCursorIndex::default();
        let count = 128 * MAX_SAMPLES * 3;
        for n in 0..count {
            index.append(n as u64 + 1, n as u64 * 16, (n as u64 + 1) * 16, None);
        }
        assert!(index.samples.len() <= MAX_SAMPLES);
        for after in [0, 1, 130, count as u64 / 2, count as u64 - 1] {
            let offset = index.seek_offset(after, count as u64 * 16, None);
            assert!(offset / 16 <= after);
            assert!(after - offset / 16 < index.stride as u64);
        }
        assert_eq!(
            index.seek_offset(count as u64, count as u64 * 16, None),
            count as u64 * 16
        );
        assert_eq!(index.seek_offset(1000, 1, None), 0);
    }

    #[test]
    fn invalidated_or_non_monotonic_files_use_safe_sequential_reads() {
        let mut index = SpoolCursorIndex::default();
        index.append(10, 0, 16, None);
        index.append(9, 16, 32, None);
        assert_eq!(index.seek_offset(100, 32, None), 0);
        let mut index = SpoolCursorIndex::default();
        index.append(1, 16, 32, None);
        assert_eq!(index.seek_offset(100, 32, None), 0);
        let mut index = SpoolCursorIndex::default();
        index.append(1, 0, 16, Some(SystemTime::UNIX_EPOCH));
        assert_eq!(index.seek_offset(100, 16, None), 0);
    }
}
