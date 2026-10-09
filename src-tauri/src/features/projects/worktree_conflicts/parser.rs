//! 有界、按字节偏移解析 Git 冲突；从原始字节重建，避免改写 BOM、CRLF 和末尾换行。

pub const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_LINES: usize = 20_000;
pub const MAX_LINE_BYTES: usize = 64 * 1024;
pub const MAX_BLOCKS: usize = 2_000;
pub const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub start: usize,
    pub end: usize,
    pub worktree: std::ops::Range<usize>,
    pub base: std::ops::Range<usize>,
    pub ancestor: Option<std::ops::Range<usize>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fallback {
    TooLarge,
    Binary,
    Encoding,
    MixedNewlines,
    Malformed,
    NoMarkers,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    Base,
    Worktree,
    Both,
    Edited(Vec<u8>),
}

/// 判断完整行是否为指定长度的标记；拒绝把更长的普通文本误当标记。
fn marker(line: &[u8], byte: u8, size: usize, label: bool) -> bool {
    if line.len() < size || !line[..size].iter().all(|c| *c == byte) {
        return false;
    }
    let suffix = &line[size..];
    suffix.is_empty() || (label && suffix.first() == Some(&b' '))
}

/// 解析两段/diff3 冲突；stage2 位于上段（工作树），stage3 位于下段（目标分支）。
pub fn parse(source: &[u8], marker_size: usize) -> Result<Vec<Block>, Fallback> {
    if source.len() > MAX_SOURCE_BYTES { return Err(Fallback::TooLarge); }
    if source.contains(&0) { return Err(Fallback::Binary); }
    if std::str::from_utf8(source).is_err() { return Err(Fallback::Encoding); }
    if !(3..=MAX_LINE_BYTES).contains(&marker_size) { return Err(Fallback::Malformed); }
    let mut blocks = Vec::new();
    let mut offset = if source.starts_with(&[0xef, 0xbb, 0xbf]) { 3 } else { 0 };
    let mut current: Option<(usize, usize, Option<(usize, usize)>, Option<(usize, usize)>)> = None;
    let mut lines = 0;
    let mut lf = false;
    let mut crlf = false;
    while offset < source.len() {
        let length = source[offset..].iter().position(|c| *c == b'\n').map_or(source.len() - offset, |n| n + 1);
        let end = offset + length;
        lines += 1;
        if lines > MAX_LINES || length > MAX_LINE_BYTES { return Err(Fallback::TooLarge); }
        let mut line = &source[offset..end];
        if line.ends_with(b"\n") {
            line = &line[..line.len() - 1];
            if line.ends_with(b"\r") { crlf = true; line = &line[..line.len() - 1]; } else { lf = true; }
        }
        if marker(line, b'<', marker_size, true) {
            if current.is_some() { return Err(Fallback::Malformed); }
            current = Some((offset, end, None, None));
        } else if marker(line, b'|', marker_size, true) {
            let Some((_, _, ancestor, separator)) = current.as_mut() else { return Err(Fallback::Malformed); };
            if ancestor.is_some() || separator.is_some() { return Err(Fallback::Malformed); }
            *ancestor = Some((offset, end));
        } else if marker(line, b'=', marker_size, false) {
            let Some((_, _, _, separator)) = current.as_mut() else { return Err(Fallback::Malformed); };
            if separator.is_some() { return Err(Fallback::Malformed); }
            *separator = Some((offset, end));
        } else if marker(line, b'>', marker_size, true) {
            let Some((start, ours_start, ancestor, Some((split, theirs_start)))) = current.take() else { return Err(Fallback::Malformed); };
            blocks.push(Block { start, end, worktree: ours_start..ancestor.map_or(split, |a| a.0), base: theirs_start..offset, ancestor: ancestor.map(|a| a.1..split) });
            if blocks.len() > MAX_BLOCKS { return Err(Fallback::TooLarge); }
        }
        offset = end;
    }
    if current.is_some() { return Err(Fallback::Malformed); }
    if lf && crlf { return Err(Fallback::MixedNewlines); }
    if blocks.is_empty() { return Err(Fallback::NoMarkers); }
    Ok(blocks)
}

/// 仅接受完整选择集合，原样复制非冲突区间并再次校验重建结果的大小与文本边界。
pub fn rebuild(source: &[u8], blocks: &[Block], choices: &[Choice]) -> Result<Vec<u8>, Fallback> {
    if blocks.is_empty() || blocks.len() != choices.len() { return Err(Fallback::Malformed); }
    let mut result = Vec::new();
    let mut cursor = 0;
    for (block, choice) in blocks.iter().zip(choices) {
        if block.start < cursor || block.end > source.len() || block.start > block.end
            || block.worktree.start > block.worktree.end || block.base.start > block.base.end
            || block.worktree.start < block.start || block.worktree.end > block.end
            || block.base.start < block.start || block.base.end > block.end { return Err(Fallback::Malformed); }
        result.extend_from_slice(&source[cursor..block.start]);
        match choice {
            Choice::Base => result.extend_from_slice(&source[block.base.clone()]),
            Choice::Worktree => result.extend_from_slice(&source[block.worktree.clone()]),
            Choice::Both => { result.extend_from_slice(&source[block.base.clone()]); result.extend_from_slice(&source[block.worktree.clone()]); }
            Choice::Edited(bytes) => result.extend_from_slice(bytes),
        }
        if result.len() > MAX_SOURCE_BYTES { return Err(Fallback::TooLarge); }
        cursor = block.end;
    }
    result.extend_from_slice(&source[cursor..]);
    if result.len() > MAX_SOURCE_BYTES || result.split(|c| *c == b'\n').count() > MAX_LINES
        || result.split(|c| *c == b'\n').any(|line| line.len() > MAX_LINE_BYTES) { return Err(Fallback::TooLarge); }
    if result.contains(&0) { return Err(Fallback::Binary); }
    if std::str::from_utf8(&result).is_err() { return Err(Fallback::Encoding); }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证左右映射和非冲突字节不变。
    #[test]
    fn preserves_bom_crlf_and_final_line() {
        let s = b"\xef\xbb\xbfprefix\r\n<<<<<<< HEAD\r\nours\r\n||||||| ancestor\r\nold\r\n=======\r\ntheirs\r\n>>>>>>> main\r\nlast";
        let blocks = parse(s, 7).unwrap();
        assert_eq!(&s[blocks[0].worktree.clone()], b"ours\r\n");
        assert_eq!(&s[blocks[0].base.clone()], b"theirs\r\n");
        assert_eq!(rebuild(s, &blocks, &[Choice::Base]).unwrap(), b"\xef\xbb\xbfprefix\r\ntheirs\r\nlast");
        assert_eq!(rebuild(s, &blocks, &[Choice::Worktree]).unwrap(), b"\xef\xbb\xbfprefix\r\nours\r\nlast");
    }

    /// 自定义标记长度仍能保留无末尾换行和空侧。
    #[test]
    fn custom_markers_and_empty_side() {
        let s = b"<<<<<<<<<< ours\n==========\nbase\n>>>>>>>>>> main";
        let blocks = parse(s, 10).unwrap();
        assert_eq!(rebuild(s, &blocks, &[Choice::Worktree]).unwrap(), b"");
        assert_eq!(rebuild(s, &blocks, &[Choice::Both]).unwrap(), b"base\n");
    }

    /// 不完整、嵌套、重复分隔符和混合换行均不可逐块写入。
    #[test]
    fn rejects_ambiguous_input() {
        for s in [b"<<<<<<< a\na\n".as_slice(), b"=======\n", b"<<<<<<< a\n<<<<<<< b\n=======\n>>>>>>> c\n", b"<<<<<<< a\n=======\n=======\n>>>>>>> b"] { assert_eq!(parse(s, 7), Err(Fallback::Malformed)); }
        assert_eq!(parse(b"<<<<<<< a\r\na\n=======\nb\n>>>>>>> b", 7), Err(Fallback::MixedNewlines));
        assert_eq!(parse(b"plain", 7), Err(Fallback::NoMarkers));
        assert_eq!(parse(b"a\0b", 7), Err(Fallback::Binary));
        assert_eq!(parse(&[0xff], 7), Err(Fallback::Encoding));
    }

    /// 独立限制源、行、块、重建字节并拒绝部分确认。
    #[test]
    fn enforces_limits_and_complete_choices() {
        assert_eq!(parse(&vec![b'x'; MAX_SOURCE_BYTES + 1], 7), Err(Fallback::TooLarge));
        assert_eq!(parse(&vec![b'\n'; MAX_LINES + 1], 7), Err(Fallback::TooLarge));
        let s = b"<<<<<<< a\nx\n=======\ny\n>>>>>>> b";
        let blocks = parse(s, 7).unwrap();
        assert_eq!(rebuild(s, &blocks, &[]), Err(Fallback::Malformed));
        assert_eq!(rebuild(s, &blocks, &[Choice::Edited(vec![b'x'; MAX_SOURCE_BYTES + 1])]), Err(Fallback::TooLarge));
        let many = b"<<<<<<< a\n=======\n>>>>>>> b\n".repeat(MAX_BLOCKS + 1);
        assert_eq!(parse(&many, 7), Err(Fallback::TooLarge));
    }
}
