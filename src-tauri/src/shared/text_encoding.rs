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

// 优先按 BOM 解码 UTF-8/UTF-16；无 BOM 时先排除疑似二进制，再尝试 UTF-8 和传统编码探测。
// 返回编码、BOM 和探测标记供原格式保存使用；非法编码不以替换字符吞掉错误。
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

// 按已知编码解码完整字节片段，不重新猜测编码；仅在请求时剥离片段起始的匹配 BOM。
// 不保存跨片段解码状态，因此调用方必须保证片段没有截断多字节字符。
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

// 按指定编码严格回写文本；UTF-8/UTF-16 遵循 BOM 标记，传统编码不额外添加 BOM。
// 无法表示的字符返回独立错误，避免保存时静默丢字或自动转换编码。
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

// 忽略大小写比较规范标签 utf-8，不把 utf8 等别名视为匹配。
pub(crate) fn is_utf8_encoding(encoding: &str) -> bool {
    encoding.eq_ignore_ascii_case(UTF8_LABEL)
}

// 严格验证探测编码；仅当 GBK 解码失败时追加尝试 GB18030，并返回实际采用的编码。
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

// 解析传统编码标签，拒绝未知标签、replacement 及由专用分支处理的 UTF-8/UTF-16。
fn resolve_legacy_encoding(label: &str) -> Result<&'static Encoding, &'static str> {
    Encoding::for_label_no_replacement(label.as_bytes())
        .filter(|encoding| {
            *encoding != encoding_rs::UTF_8
                && *encoding != encoding_rs::UTF_16LE
                && *encoding != encoding_rs::UTF_16BE
        })
        .ok_or("unsupported_text_encoding")
}

// 将编码库的标准名称转成小写，稳定读写接口中持久化的编码标签。
fn canonical_label(encoding: &'static Encoding) -> String {
    encoding.name().to_ascii_lowercase()
}

// 只接受合法 UTF-8 字节；BOM 是否剥离由调用方决定。
fn decode_utf8(bytes: &[u8]) -> Result<String, &'static str> {
    std::str::from_utf8(bytes)
        .map(str::to_string)
        .map_err(|_| "text_decode_failed")
}

// 按指定端序读取双字节单元，拒绝奇数字节数和非法代理对；输入不含待剥离的 BOM。
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

// 将文本转换为指定端序的 UTF-16 单元，并按需在开头写入对应 BOM。
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

// 仅抽查前 8 KiB：NUL 直接判为二进制，其余异常控制字节需超过两个且占比大于 1%。
// 常见换行、制表、退格、换页和 ESC 被允许；这是启发式筛选，不是完整文件类型检测。
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

// 对探测解码结果抽查前 8192 个 Unicode 字符，按 NUL 或异常控制字符密度排除疑似二进制。
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
    // 验证中文 UTF-8 解码及带 BOM 文本的元数据、内容与字节回写。
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
    // 验证 UTF-16 大小端均由 BOM 正确识别，并保持原始端序和 BOM 字节。
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
    // 用中文样本验证传统编码探测标记，并确认回写后的字节没有变化。
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
    // 确认含 NUL 的二进制输入与 GBK 无法表示的字符分别返回对应错误。
    fn rejects_binary_and_unmappable_text() {
        assert_eq!(decode_text(b"PNG\0\x01\x02").unwrap_err(), "binary_file");
        assert_eq!(
            encode_text("你好🙂", "gbk", false).unwrap_err(),
            "text_encoding_unmappable"
        );
    }

    #[test]
    // 验证已知 GBK 片段直接解码，以及 UTF-16 首片段可选择剥离 BOM。
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
