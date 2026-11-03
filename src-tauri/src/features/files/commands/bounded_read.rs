use std::io::Read;

// Metadata can race with writers; cap the reader itself and check the sentinel byte.
pub(super) fn read_bounded(reader: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|err| format!("read_file_failed: {err}"))?;
    if bytes.len() as u64 > limit {
        return Err("file_too_large".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    #[test]
    fn bounded_reader_accepts_exact_limit_and_rejects_growth() {
        assert_eq!(read_bounded(Cursor::new(b"1234"), 4).unwrap(), b"1234");
        let mut input = Cursor::new(b"123456789");
        assert_eq!(read_bounded(&mut input, 4).unwrap_err(), "file_too_large");
        assert_eq!(input.position(), 5);
        let mut rest = Vec::new();
        input.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"6789");
    }
}
