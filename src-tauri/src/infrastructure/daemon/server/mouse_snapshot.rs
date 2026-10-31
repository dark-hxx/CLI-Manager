const RESET_MOUSE_TRACKING: &[u8] = b"\x1b[?9;1000;1002;1003l";

/// Checkpoint-only compatibility for the old SerializeAddon's missing encoding.
/// Raw output must never pass here: DEFAULT is a legitimate live mouse encoding.
pub(super) fn restore_legacy_mouse_snapshot(data: &mut Vec<u8>) {
    let mut rest = data.as_slice();
    let mut tracking = false;
    let mut encoding_declared = false;
    while let Some(start) = rest.windows(3).position(|bytes| bytes == b"\x1b[?") {
        rest = &rest[start + 3..];
        let len = rest
            .iter()
            .take_while(|byte| byte.is_ascii_digit() || **byte == b';')
            .count();
        let Some(final_byte) = rest.get(len).copied() else {
            break;
        };
        if matches!(final_byte, b'h' | b'l') {
            for mode in rest[..len].split(|byte| *byte == b';') {
                if matches!(mode, b"1006" | b"1016") {
                    encoding_declared = true;
                }
                if matches!(mode, b"9" | b"1000" | b"1002" | b"1003") {
                    tracking = final_byte == b'h';
                }
            }
        }
        rest = &rest[len + 1..];
    }
    if tracking && !encoding_declared {
        data.extend_from_slice(RESET_MOUSE_TRACKING);
    }
}
