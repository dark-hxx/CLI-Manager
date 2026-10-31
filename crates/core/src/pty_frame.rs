//! 共享终端二进制协议；保持 v1 头部和客户端输入校验。
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const BINARY_PROTOCOL_VERSION: u8 = 1;
pub const BINARY_KIND_OUTPUT: u8 = 1;
pub const BINARY_KIND_REPLAY: u8 = 2;
pub const BINARY_KIND_INPUT: u8 = 3;
pub const BINARY_KIND_CHECKPOINT: u8 = 4;
pub const BINARY_KIND_REPLAY_RESET: u8 = 5;
const BINARY_HEADER_BYTES: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryTerminalFrame {
    pub kind: u8,
    pub session_id: String,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub data: Vec<u8>,
}

/// WebSocket 二进制终端帧：version/kind/sessionLen/sequence/cols/rows/dataLen + payload。
// 校验种类、字段长度和总帧上限后写入大端头部，再原样拼接会话 ID 与负载字节。
pub fn encode_binary_terminal_frame(
    kind: u8,
    session_id: &str,
    sequence: u64,
    cols: u16,
    rows: u16,
    data: &[u8],
) -> Result<Vec<u8>, String> {
    if !matches!(
        kind,
        BINARY_KIND_OUTPUT
            | BINARY_KIND_REPLAY
            | BINARY_KIND_INPUT
            | BINARY_KIND_CHECKPOINT
            | BINARY_KIND_REPLAY_RESET
    ) {
        return Err("invalid binary frame kind".to_string());
    }
    let session_bytes = session_id.as_bytes();
    let session_len = u16::try_from(session_bytes.len())
        .map_err(|_| "session id too long for binary frame".to_string())?;
    let data_len = u32::try_from(data.len())
        .map_err(|_| "terminal payload too large for binary frame".to_string())?;
    if BINARY_HEADER_BYTES + session_bytes.len() + data.len() > MAX_FRAME_BYTES {
        return Err("binary frame too large".to_string());
    }

    let mut frame = Vec::with_capacity(BINARY_HEADER_BYTES + session_bytes.len() + data.len());
    frame.push(BINARY_PROTOCOL_VERSION);
    frame.push(kind);
    frame.extend_from_slice(&session_len.to_be_bytes());
    frame.extend_from_slice(&sequence.to_be_bytes());
    frame.extend_from_slice(&cols.to_be_bytes());
    frame.extend_from_slice(&rows.to_be_bytes());
    frame.extend_from_slice(&data_len.to_be_bytes());
    frame.extend_from_slice(session_bytes);
    frame.extend_from_slice(data);
    Ok(frame)
}

// 仅接受客户端输入/检查点帧，校验版本、精确长度和 ID 的 UTF-8；负载保持原始字节。
pub fn decode_binary_terminal_frame(frame: &[u8]) -> Result<BinaryTerminalFrame, String> {
    let frame = decode_frame(frame, false)?;
    Ok(BinaryTerminalFrame {
        kind: frame.kind,
        session_id: frame.session_id.to_owned(),
        sequence: frame.sequence,
        cols: frame.cols,
        rows: frame.rows,
        data: frame.data.to_vec(),
    })
}

/// 借用 WebSocket 消息，不复制输出 payload。调用者在解析提交前保留消息所有权。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalFrameRef<'a> {
    pub kind: u8,
    pub session_id: &'a str,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub data: &'a [u8],
}

pub fn decode_daemon_binary_frame(frame: &[u8]) -> Result<TerminalFrameRef<'_>, String> {
    decode_frame(frame, true)
}

fn decode_frame(frame: &[u8], from_daemon: bool) -> Result<TerminalFrameRef<'_>, String> {
    if frame.len() < BINARY_HEADER_BYTES {
        return Err("binary frame too short".to_string());
    }
    if frame[0] != BINARY_PROTOCOL_VERSION {
        return Err("unsupported binary protocol version".to_string());
    }
    let kind = frame[1];
    if from_daemon
        && !matches!(
            kind,
            BINARY_KIND_OUTPUT | BINARY_KIND_REPLAY | BINARY_KIND_REPLAY_RESET
        )
    {
        return Err("unsupported daemon binary frame kind".to_string());
    }
    if !from_daemon && !matches!(kind, BINARY_KIND_INPUT | BINARY_KIND_CHECKPOINT) {
        return Err("unsupported client binary frame kind".to_string());
    }
    let session_len = u16::from_be_bytes([frame[2], frame[3]]) as usize;
    let sequence = u64::from_be_bytes(
        frame[4..12]
            .try_into()
            .map_err(|_| "invalid binary sequence".to_string())?,
    );
    let cols = u16::from_be_bytes([frame[12], frame[13]]);
    let rows = u16::from_be_bytes([frame[14], frame[15]]);
    let data_len = u32::from_be_bytes(
        frame[16..20]
            .try_into()
            .map_err(|_| "invalid binary data length".to_string())?,
    ) as usize;
    let expected = BINARY_HEADER_BYTES
        .checked_add(session_len)
        .and_then(|value| value.checked_add(data_len))
        .ok_or_else(|| "binary frame length overflow".to_string())?;
    if expected != frame.len() || expected > MAX_FRAME_BYTES {
        return Err("invalid binary frame length".to_string());
    }
    let session_start = BINARY_HEADER_BYTES;
    let data_start = session_start + session_len;
    let session_id = std::str::from_utf8(&frame[session_start..data_start])
        .map_err(|_| "binary session id is not utf-8".to_string())?;
    Ok(TerminalFrameRef {
        kind,
        session_id,
        sequence,
        cols,
        rows,
        data: &frame[data_start..],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_header_and_zero_copy_payload_match_v1() {
        let bytes = encode_binary_terminal_frame(BINARY_KIND_OUTPUT, "会话", 42, 120, 30, b"hello")
            .unwrap();
        assert_eq!(&bytes[..4], &[1, 1, 0, 6]);
        assert_eq!(&bytes[4..12], &42_u64.to_be_bytes());
        let frame = decode_daemon_binary_frame(&bytes).unwrap();
        assert_eq!(
            (frame.session_id, frame.sequence, frame.cols, frame.rows),
            ("会话", 42, 120, 30)
        );
        assert_eq!(frame.data, b"hello");
        assert_eq!(frame.data.as_ptr(), bytes[26..].as_ptr());
        assert!(decode_binary_terminal_frame(&bytes).is_err());
    }

    #[test]
    fn validates_direction_utf8_lengths_and_version_without_panicking() {
        for kind in 1..=5 {
            let bytes = encode_binary_terminal_frame(kind, "s", 1, 80, 24, &[0xff]).unwrap();
            assert_eq!(
                decode_daemon_binary_frame(&bytes).is_ok(),
                matches!(kind, 1 | 2 | 5)
            );
            assert_eq!(
                decode_binary_terminal_frame(&bytes).is_ok(),
                matches!(kind, 3 | 4)
            );
            for size in 0..bytes.len() {
                assert!(decode_daemon_binary_frame(&bytes[..size]).is_err());
            }
        }
        let valid = encode_binary_terminal_frame(1, "s", 1, 80, 24, b"ok").unwrap();
        for offset in [0, 1, 2, 3, 16, 17, 18, 19, 20] {
            let mut invalid = valid.clone();
            invalid[offset] = 0xff;
            assert!(decode_daemon_binary_frame(&invalid).is_err());
        }
        let mut trailing = valid;
        trailing.push(0);
        assert!(decode_daemon_binary_frame(&trailing).is_err());
        assert!(encode_binary_terminal_frame(0, "s", 1, 1, 1, b"").is_err());
    }
}
