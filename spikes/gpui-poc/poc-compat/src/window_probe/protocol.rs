//! The Windows wire format of tauri-plugin-single-instance 2.4.2.
pub const MAX_BYTES: usize = 65_536;

pub fn encode(cwd: &str, args: &[String]) -> Result<Vec<u8>, String> {
    if args.is_empty()
        || std::iter::once(cwd)
            .chain(args.iter().map(String::as_str))
            .any(|s| s.contains(['|', '\0']))
    {
        return Err("single-instance payload has no argv or contains |/NUL".into());
    }
    let payload = format!("{cwd}|{}\0", args.join("|")).into_bytes();
    if payload.len() > MAX_BYTES {
        return Err("single-instance payload exceeds 64 KiB".into());
    }
    Ok(payload)
}

pub fn decode(bytes: &[u8]) -> Result<(String, Vec<String>), String> {
    if bytes.len() > MAX_BYTES || bytes.last() != Some(&0) {
        return Err("invalid payload size or terminator".into());
    }
    let text = std::str::from_utf8(&bytes[..bytes.len() - 1]).map_err(|e| e.to_string())?;
    if text.contains('\0') {
        return Err("interior NUL".into());
    }
    let (cwd, args) = text.split_once('|').ok_or("missing argv")?;
    Ok((
        cwd.to_string(),
        args.split('|').map(str::to_string).collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_and_empty_arguments_round_trip() {
        let args = vec!["poc-window".into(), "中文🙂".into(), "".into()];
        assert_eq!(
            decode(&encode("F:\\实验", &args).unwrap()).unwrap(),
            ("F:\\实验".into(), args)
        );
    }
    #[test]
    fn rejects_ambiguous_or_oversized_input() {
        assert!(encode("cwd", &["a|b".into()]).is_err());
        assert!(encode("cwd", &["a\0b".into()]).is_err());
        assert!(encode("cwd", &["a".repeat(MAX_BYTES)]).is_err());
        assert!(encode("cwd", &[]).is_err());
        for bad in [
            &b""[..],
            &b"cwd|arg"[..],
            &b"cwd\0|arg\0"[..],
            &b"no-argv\0"[..],
            &b"cwd|\xff\0"[..],
        ] {
            assert!(decode(bad).is_err());
        }
    }
}
