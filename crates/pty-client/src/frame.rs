use bytes::Bytes;
use cli_manager_core::pty_frame::{decode_daemon_binary_frame, BINARY_KIND_REPLAY_RESET};

/// Payload shares the original WebSocket message allocation.
#[derive(Debug, Clone)]
pub struct Output {
    pub kind: u8,
    pub session_id: String,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub data: Bytes,
}

impl Output {
    pub fn decode(bytes: Bytes) -> Result<Self, String> {
        let decoded = decode_daemon_binary_frame(&bytes)?;
        let data_start = bytes.len() - decoded.data.len();
        Ok(Self {
            kind: decoded.kind,
            session_id: decoded.session_id.to_owned(),
            sequence: decoded.sequence,
            cols: decoded.cols,
            rows: decoded.rows,
            data: bytes.slice(data_start..),
        })
    }

    /// Legacy daemon counts JavaScript UTF-16 code units, not bytes.
    pub fn utf16_units(&self) -> usize {
        if self.kind == BINARY_KIND_REPLAY_RESET {
            return 0;
        }
        String::from_utf8_lossy(&self.data).encode_utf16().count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cli_manager_core::pty_frame::encode_binary_terminal_frame;

    #[test]
    fn payload_is_shared_and_legacy_ack_counts_unicode_correctly() {
        let bytes = Bytes::from(
            encode_binary_terminal_frame(1, "s", 7, 80, 24, "A中😀".as_bytes()).unwrap(),
        );
        let output = Output::decode(bytes.clone()).unwrap();
        assert_eq!(output.data.as_ptr(), bytes[21..].as_ptr());
        assert_eq!(output.utf16_units(), 4);
        assert_eq!(output.sequence, 7);
    }
}
