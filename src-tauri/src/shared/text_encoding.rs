use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{EncoderResult, Encoding, GB18030};

const UTF8_LABEL: &str = "utf-8";
const UTF16_LE_LABEL: &str = "utf-16le";
const UTF16_BE_LABEL: &str = "utf-16be";
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
const UTF16_LE_BOM: &[u8] = b"\xFF\xFE";
const UTF16_BE_BOM: &[u8] = b"\xFE\xFF";
const BINARY_SAMPLE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DecodedText {
    pub content: String,
    pub encoding: String,
    pub has_bom: bool,
    pub guessed: bool,
}

pub(crate) fn decode_text(bytes: &[u8]) -> Result<DecodedText, &'static str> {
    if let Some(rest) = bytes.strip_prefix(UTF8_BOM) {
        return Ok(DecodedText {
            content: decode_utf8(rest)?,
            encoding: UTF8_LABEL.to_string(),
            has_bom: true,
            guessed: false,
        });
    }
    if let Some(rest) = bytes.strip_prefix(UTF16_LE_BOM) {
        return Ok(DecodedText {
            content: decode_utf16(rest, true)?,
            encoding: UTF16_LE_LABEL.to_string(),
            has_bom: true,
            guessed: false,
        });
    }
    if let Some(rest) = bytes.strip_prefix(UTF16_BE_BOM) {
        return Ok(DecodedText {
            content: decode_utf16(rest, false)?,
            encoding: UTF16_BE_LABEL.to_string(),
            has_bom: true,
            guessed: false,
        });
    }
    if looks_binary_bytes(bytes) {
        return Err("binary_file");
    }
    if let Ok(content) = std::str::from_utf8(bytes) {
        return Ok(DecodedText {
            content: content.to_string(),
            encoding: UTF8_LABEL.to_string(),
            has_bom: false,
            guessed: false,
        });
    }

    let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    let guessed = detector.guess(None, Utf8Detection::Deny);
    let (content, encoding) = decode_guessed(bytes, guessed)?;
    if looks_binary_text(&content) {
        return Err("binary_file");
    }

    Ok(DecodedText {
        content,
        encoding: canonical_label(encoding),
        has_bom: false,
        guessed: true,
    })
}

pub(crate) fn decode_text_fragment(
    bytes: &[u8],
    encoding: &str,
    strip_bom: bool,
) -> Result<String, &'static str> {
    if encoding.eq_ignore_ascii_case(UTF8_LABEL) {
        let input = if strip_bom {
            bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes)
        } else {
            bytes
        };
        return decode_utf8(input);
    }
    if encoding.eq_ignore_ascii_case(UTF16_LE_LABEL) {
        let input = if strip_bom {
            bytes.strip_prefix(UTF16_LE_BOM).unwrap_or(bytes)
        } else {
            bytes
        };
        return decode_utf16(input, true);
    }
    if encoding.eq_ignore_ascii_case(UTF16_BE_LABEL) {
        let input = if strip_bom {
            bytes.strip_prefix(UTF16_BE_BOM).unwrap_or(bytes)
        } else {
            bytes
        };
        return decode_utf16(input, false);
    }

    let encoding = resolve_legacy_encoding(encoding)?;
    encoding
        .decode_without_bom_handling_and_without_replacement(bytes)
        .map(|content| content.into_owned())
        .ok_or("text_decode_failed")
}

pub(crate) fn encode_text(
    content: &str,
    encoding: &str,
    has_bom: bool,
) -> Result<Vec<u8>, &'static str> {
    if encoding.eq_ignore_ascii_case(UTF8_LABEL) {
        let mut bytes = Vec::with_capacity(content.len() + usize::from(has_bom) * UTF8_BOM.len());
        if has_bom {
            bytes.extend_from_slice(UTF8_BOM);
        }
        bytes.extend_from_slice(content.as_bytes());
        return Ok(bytes);
    }
    if encoding.eq_ignore_ascii_case(UTF16_LE_LABEL) {
        return Ok(encode_utf16(content, true, has_bom));
    }
    if encoding.eq_ignore_ascii_case(UTF16_BE_LABEL) {
        return Ok(encode_utf16(content, false, has_bom));
    }

    let encoding = resolve_legacy_encoding(encoding)?;
    let mut encoder = encoding.new_encoder();
    let capacity = encoder
        .max_buffer_length_from_utf8_without_replacement(content.len())
        .ok_or("text_encode_failed")?;
    let mut bytes = Vec::with_capacity(capacity);
    let (result, read) =
        encoder.encode_from_utf8_to_vec_without_replacement(content, &mut bytes, true);
    match result {
        EncoderResult::InputEmpty if read == content.len() => Ok(bytes),
        EncoderResult::Unmappable(_) => Err("text_encoding_unmappable"),
        EncoderResult::InputEmpty | EncoderResult::OutputFull => Err("text_encode_failed"),
    }
}

pub(crate) fn is_utf8_encoding(encoding: &str) -> bool {
    encoding.eq_ignore_ascii_case(UTF8_LABEL)
}

fn decode_guessed(
    bytes: &[u8],
    encoding: &'static Encoding,
) -> Result<(String, &'static Encoding), &'static str> {
    if let Some(content) = encoding.decode_without_bom_handling_and_without_replacement(bytes) {
        return Ok((content.into_owned(), encoding));
    }
    if encoding == encoding_rs::GBK {
        if let Some(content) = GB18030.decode_without_bom_handling_and_without_replacement(bytes) {
            return Ok((content.into_owned(), GB18030));
        }
    }
    Err("text_decode_failed")
}

fn resolve_legacy_encoding(label: &str) -> Result<&'static Encoding, &'static str> {
    Encoding::for_label_no_replacement(label.as_bytes())
        .filter(|encoding| {
            *encoding != encoding_rs::UTF_8
                && *encoding != encoding_rs::UTF_16LE
                && *encoding != encoding_rs::UTF_16BE
        })
        .ok_or("unsupported_text_encoding")
}

fn canonical_label(encoding: &'static Encoding) -> String {
    encoding.name().to_ascii_lowercase()
}

fn decode_utf8(bytes: &[u8]) -> Result<String, &'static str> {
    std::str::from_utf8(bytes)
        .map(str::to_string)
        .map_err(|_| "text_decode_failed")
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, &'static str> {
    if bytes.len() % 2 != 0 {
        return Err("text_decode_failed");
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| {
            let pair = [chunk[0], chunk[1]];
            if little_endian {
                u16::from_le_bytes(pair)
            } else {
                u16::from_be_bytes(pair)
            }
        })
        .collect();
    String::from_utf16(&units).map_err(|_| "text_decode_failed")
}

fn encode_utf16(content: &str, little_endian: bool, has_bom: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(content.len() * 2 + usize::from(has_bom) * 2);
    if has_bom {
        bytes.extend_from_slice(if little_endian {
            UTF16_LE_BOM
        } else {
            UTF16_BE_BOM
        });
    }
    for unit in content.encode_utf16() {
        let encoded = if little_endian {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        };
        bytes.extend_from_slice(&encoded);
    }
    bytes
}

fn looks_binary_bytes(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(BINARY_SAMPLE_BYTES)];
    if sample.contains(&0) {
        return true;
    }
    let suspicious = sample
        .iter()
        .filter(|byte| {
            **byte < 0x20 && !matches!(**byte, b'\n' | b'\r' | b'\t' | 0x08 | 0x0C | 0x1B)
        })
        .count();
    suspicious > 2 && suspicious * 100 > sample.len().max(1)
}

fn looks_binary_text(content: &str) -> bool {
    let mut total = 0usize;
    let mut suspicious = 0usize;
    for ch in content.chars().take(BINARY_SAMPLE_BYTES) {
        total += 1;
        if ch == '\0' {
            return true;
        }
        if ch.is_control() && !matches!(ch, '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' | '\u{1b}') {
            suspicious += 1;
        }
    }
    suspicious > 2 && suspicious * 100 > total.max(1)
}

#[cfg(test)]
mod tests {
    use super::{decode_text, decode_text_fragment, encode_text};

    #[test]
    fn utf8_and_utf8_bom_round_trip() {
        let plain = decode_text("你好".as_bytes()).unwrap();
        assert_eq!(plain.encoding, "utf-8");
        assert!(!plain.has_bom);
        assert_eq!(plain.content, "你好");

        let bom_bytes = b"\xEF\xBB\xBFhello";
        let bom = decode_text(bom_bytes).unwrap();
        assert_eq!(bom.content, "hello");
        assert!(bom.has_bom);
        assert_eq!(
            encode_text(&bom.content, &bom.encoding, bom.has_bom).unwrap(),
            bom_bytes
        );
    }

    #[test]
    fn utf16_bom_round_trip() {
        let le = [0xFF, 0xFE, 0x60, 0x4F, 0x7D, 0x59];
        let decoded_le = decode_text(&le).unwrap();
        assert_eq!(decoded_le.content, "你好");
        assert_eq!(decoded_le.encoding, "utf-16le");
        assert_eq!(
            encode_text(&decoded_le.content, &decoded_le.encoding, true).unwrap(),
            le
        );

        let be = [0xFE, 0xFF, 0x4F, 0x60, 0x59, 0x7D];
        let decoded_be = decode_text(&be).unwrap();
        assert_eq!(decoded_be.content, "你好");
        assert_eq!(decoded_be.encoding, "utf-16be");
        assert_eq!(
            encode_text(&decoded_be.content, &decoded_be.encoding, true).unwrap(),
            be
        );
    }

    #[test]
    fn detects_and_preserves_gbk() {
        let source = "你好，世界。这是一个中文编码测试。";
        let (bytes, _, had_errors) = encoding_rs::GBK.encode(source);
        assert!(!had_errors);

        let decoded = decode_text(&bytes).unwrap();
        assert_eq!(decoded.content, source);
        assert!(decoded.guessed);
        assert_eq!(
            encode_text(&decoded.content, &decoded.encoding, false).unwrap(),
            bytes.as_ref()
        );
    }

    #[test]
    fn rejects_binary_and_unmappable_text() {
        assert_eq!(decode_text(b"PNG\0\x01\x02").unwrap_err(), "binary_file");
        assert_eq!(
            encode_text("你好🙂", "gbk", false).unwrap_err(),
            "text_encoding_unmappable"
        );
    }

    #[test]
    fn decodes_known_fragments_without_redetecting() {
        assert_eq!(
            decode_text_fragment(&[0xC4, 0xE3, 0xBA, 0xC3], "gbk", false).unwrap(),
            "你好"
        );
        assert_eq!(
            decode_text_fragment(&[0xFF, 0xFE, 0x60, 0x4F], "utf-16le", true).unwrap(),
            "你"
        );
    }
}
