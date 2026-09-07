//! PTY 字节流边界保护：在 chunk emit 前，确保不切断 UTF-8 字符与 ANSI 转义序列。
//!
//! Reader 线程按 OS 提供的字节块累积 pending buffer，但 `reader.read()` 没有任何
//! 字符 / 控制序列对齐保证。如果 chunk 被切在多字节 UTF-8 字符或未终结的
//! ANSI CSI/OSC 序列中间，前端 xterm 会出现：
//!   - 中文 / Emoji 显示为 `U+FFFD`（替换符）+ 残留字节被当 SGR 参数处理
//!   - 背景色 / 前景色 SGR 状态污染（图里左侧红色竖条的成因）
//!
//! 本模块提供纯函数 [`safe_emit_boundary`]，输入 pending bytes，返回可安全
//! emit 的前缀长度；剩余字节由调用方保留，与下一次 read 拼接。

/// 计算可安全 emit 的字节数：必须同时满足 UTF-8 完整 + 不在未终结的 ESC 序列内。
///
/// 调用方应 `emit(bytes[..safe])` 然后 `pending.drain(..safe)`，剩余字节保留。
///
/// # 性能
///
/// O(n)，最坏 n=pending 长度；正常 reader 节奏下 n ≤ 32KB。
pub fn safe_emit_boundary(bytes: &[u8]) -> usize {
    let esc_safe = esc_safe_prefix(bytes);
    utf8_safe_prefix(&bytes[..esc_safe])
}

/// 返回 bytes 中 UTF-8 安全前缀长度。只截断"末尾未完成的多字节序列"，
/// 中间的非法字节保留原位（TextDecoder 会将其替换为 U+FFFD，与传统 PTY 一致）。
fn utf8_safe_prefix(bytes: &[u8]) -> usize {
    let n = bytes.len();
    let max_back = 4usize.min(n);
    for back in 1..=max_back {
        let b = bytes[n - back];
        if b < 0x80 {
            return n; // ASCII 字符，整段已 UTF-8 边界对齐
        }
        if b >= 0xC0 {
            let expected = if b < 0xE0 {
                2
            } else if b < 0xF0 {
                3
            } else if b < 0xF8 {
                4
            } else {
                1 // 非法起始字节，按 1 字节处理（让前端 decode 替换为 U+FFFD）
            };
            if back >= expected {
                return n;
            }
            return n - back;
        }
        // 0x80..=0xBF: continuation 字节，继续向前查找起始字节
    }
    // 末尾连续 4 个 continuation 字节（valid UTF-8 不可能），按已对齐处理
    n
}

/// 返回 bytes 中 ESC 序列安全前缀长度：若末尾存在未终结的 ESC 序列，
/// 返回该序列起始位置；否则返回 bytes.len()。
fn esc_safe_prefix(bytes: &[u8]) -> usize {
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != 0x1B {
            i += 1;
            continue;
        }
        match parse_esc_sequence(&bytes[i..]) {
            Some(consumed) => i += consumed,
            None => return i, // 未终结，从 ESC 处截断
        }
    }
    bytes.len()
}

/// 尝试解析以 0x1B 开头的 ESC 序列，返回消耗字节数；未终结返回 None。
///
/// 覆盖 ECMA-48 主要序列：
///   - CSI: `\x1B[` ... `<final 0x40-0x7E>`
///   - OSC / DCS / SOS / PM / APC: `\x1B]` `\x1BP` `\x1BX` `\x1B^` `\x1B_` ... `BEL` 或 `ESC \`
///   - 2-byte ESC: `\x1B<final 0x30-0x7E>` (如 `\x1B=`, `\x1B7`, `\x1BM`)
///   - ESC + intermediate(s) + final: `\x1B<0x20-0x2F>* <0x30-0x7E>` (如 `\x1B(B`)
fn parse_esc_sequence(seq: &[u8]) -> Option<usize> {
    debug_assert!(!seq.is_empty() && seq[0] == 0x1B);
    let intro = *seq.get(1)?;
    match intro {
        b'[' => {
            // CSI: 参数 (0x30-0x3F) → intermediate (0x20-0x2F) → final (0x40-0x7E)
            for (idx, &b) in seq[2..].iter().enumerate() {
                if (0x40..=0x7E).contains(&b) {
                    return Some(2 + idx + 1);
                }
            }
            None
        }
        b']' | b'P' | b'X' | b'^' | b'_' => {
            // OSC / DCS / SOS / PM / APC: BEL (0x07) 或 ST (ESC \) 终结
            let mut j = 2;
            while j < seq.len() {
                if seq[j] == 0x07 {
                    return Some(j + 1);
                }
                if seq[j] == 0x1B {
                    return match seq.get(j + 1) {
                        Some(&b'\\') => Some(j + 2),
                        Some(_) => Some(j), // 内嵌 ESC（源端格式错误），在此切断让外层 ESC 单独处理
                        None => None,       // 末尾 bare ESC，等待下一字节
                    };
                }
                j += 1;
            }
            None
        }
        0x30..=0x7E => Some(2), // 双字节 ESC: ESC + final
        0x20..=0x2F => {
            // ESC + intermediate(0x20-0x2F)+ + final(0x30-0x7E)
            let mut j = 2;
            while j < seq.len() && (0x20..=0x2F).contains(&seq[j]) {
                j += 1;
            }
            let final_byte = *seq.get(j)?;
            if (0x30..=0x7E).contains(&final_byte) {
                Some(j + 1)
            } else {
                None
            }
        }
        // 其它（控制字符紧跟 ESC，极罕见）：按 2 字节处理，避免无限滞留
        _ => Some(2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ----- UTF-8 边界 -----

    #[test]
    fn utf8_ascii_only() {
        assert_eq!(safe_emit_boundary(b"hello"), 5);
    }

    #[test]
    fn utf8_empty() {
        assert_eq!(safe_emit_boundary(b""), 0);
    }

    #[test]
    fn utf8_split_3byte_zhongwen() {
        // "中" = E4 B8 AD
        assert_eq!(safe_emit_boundary(&[0xE4]), 0);
        assert_eq!(safe_emit_boundary(&[0xE4, 0xB8]), 0);
        assert_eq!(safe_emit_boundary(&[0xE4, 0xB8, 0xAD]), 3);
        assert_eq!(safe_emit_boundary(&[b'A', 0xE4, 0xB8]), 1);
        assert_eq!(safe_emit_boundary(&[b'A', 0xE4, 0xB8, 0xAD]), 4);
    }

    #[test]
    fn utf8_split_4byte_emoji() {
        // 😀 = F0 9F 98 80
        assert_eq!(safe_emit_boundary(&[0xF0]), 0);
        assert_eq!(safe_emit_boundary(&[0xF0, 0x9F]), 0);
        assert_eq!(safe_emit_boundary(&[0xF0, 0x9F, 0x98]), 0);
        assert_eq!(safe_emit_boundary(&[0xF0, 0x9F, 0x98, 0x80]), 4);
    }

    #[test]
    fn utf8_invalid_byte_midstream_passthrough() {
        // 0xFF 是非法 UTF-8 起始字节；保留原位（让前端 decode 替换为 U+FFFD）
        let bytes = &[b'A', 0xFF, b'B'][..];
        assert_eq!(safe_emit_boundary(bytes), 3);
    }

    // ----- CSI -----

    #[test]
    fn csi_split_at_esc() {
        assert_eq!(safe_emit_boundary(b"hello\x1b"), 5);
    }

    #[test]
    fn csi_split_at_bracket() {
        assert_eq!(safe_emit_boundary(b"hello\x1b["), 5);
    }

    #[test]
    fn csi_split_in_params() {
        assert_eq!(safe_emit_boundary(b"hello\x1b[41"), 5);
        assert_eq!(safe_emit_boundary(b"hello\x1b[38;5;200"), 5);
    }

    #[test]
    fn csi_complete() {
        assert_eq!(safe_emit_boundary(b"hello\x1b[41m"), 10);
        assert_eq!(safe_emit_boundary(b"hello\x1b[41mworld"), 15);
        assert_eq!(safe_emit_boundary(b"\x1b[H\x1b[2J"), 7);
    }

    #[test]
    fn csi_trailing_after_complete() {
        // 前面有完整 SGR，末尾又出现未完成 CSI
        assert_eq!(safe_emit_boundary(b"\x1b[41mtext\x1b["), 9);
    }

    // ----- OSC -----

    #[test]
    fn osc_bel_terminated() {
        assert_eq!(safe_emit_boundary(b"\x1b]0;title\x07rest"), 14);
    }

    #[test]
    fn osc_st_terminated() {
        assert_eq!(safe_emit_boundary(b"\x1b]0;title\x1b\\rest"), 15);
    }

    #[test]
    fn osc_split_in_middle() {
        assert_eq!(safe_emit_boundary(b"\x1b]0;title"), 0);
    }

    #[test]
    fn osc_split_at_trailing_esc() {
        assert_eq!(safe_emit_boundary(b"\x1b]0;title\x1b"), 0);
    }

    // ----- 2-byte ESC -----

    #[test]
    fn esc_two_byte_complete() {
        assert_eq!(safe_emit_boundary(b"hello\x1b="), 7);
        assert_eq!(safe_emit_boundary(b"hello\x1b7"), 7);
        assert_eq!(safe_emit_boundary(b"hello\x1bM"), 7);
    }

    // ----- ESC + intermediate + final -----

    #[test]
    fn esc_charset_designator() {
        assert_eq!(safe_emit_boundary(b"hello\x1b(B"), 8);
        assert_eq!(safe_emit_boundary(b"hello\x1b("), 5);
    }

    // ----- 组合 -----

    #[test]
    fn mixed_cjk_and_ansi_complete() {
        // \x1B[41m + 中文 + \x1B[0m
        let bytes = b"\x1b[41m\xe4\xb8\xad\xe6\x96\x87\x1b[0m";
        assert_eq!(safe_emit_boundary(bytes), bytes.len());
    }

    #[test]
    fn mixed_cjk_cut_in_utf8() {
        // \x1B[41m + "中"(E4 B8 AD) + "文"(E6 96 …截断)
        let bytes = b"\x1b[41m\xe4\xb8\xad\xe6\x96";
        // 应该截到完整的 \x1B[41m\xe4\xb8\xad 处 = 8 字节
        assert_eq!(safe_emit_boundary(bytes), 8);
    }

    #[test]
    fn mixed_cjk_cut_in_csi() {
        // \x1B[41m + "中" + \x1B[（CSI 未完成）
        let bytes = b"\x1b[41m\xe4\xb8\xad\x1b[";
        // 截到 \x1B[41m\xe4\xb8\xad = 8 字节
        assert_eq!(safe_emit_boundary(bytes), 8);
    }

    // ----- Stress: 任意切点拼接回原流 -----

    #[test]
    fn stress_random_split_reconstructs_original() {
        // 构造一段含 ANSI + CJK + Emoji + ASCII 的真实样本
        let original: Vec<u8> =
            b"\x1b[31m[ERROR]\x1b[0m \xe6\xb5\x8b\xe8\xaf\x95 emoji \xf0\x9f\x98\x80\n\
            \x1b]0;tab title\x07normal text\n\
            \x1b[1;33mYellow\x1b[0m \xe4\xb8\xad\xe6\x96\x87 done\n"
                .iter()
                .copied()
                .collect();

        // 用一个简单的 LCG 取代外部 rand 依赖
        let mut state: u32 = 0x12345678;
        let mut next = |max: usize| -> usize {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            (state as usize) % max.max(1)
        };

        for _ in 0..500 {
            let split_at = next(original.len() + 1);
            let (first, second) = original.split_at(split_at);

            // 模拟两次 read：先喂 first，emit 安全前缀，剩余字节保留；再追加 second，emit 全部
            let mut pending: Vec<u8> = first.to_vec();
            let safe1 = safe_emit_boundary(&pending);
            let mut emitted: Vec<u8> = pending[..safe1].to_vec();
            pending.drain(..safe1);
            pending.extend_from_slice(second);
            let safe2 = safe_emit_boundary(&pending);
            emitted.extend_from_slice(&pending[..safe2]);
            pending.drain(..safe2);

            // 流末尾：模拟 reader 结束时强制 flush 剩余
            emitted.extend_from_slice(&pending);

            assert_eq!(
                emitted,
                original,
                "mismatch at split_at={split_at}: emitted len={} vs original len={}",
                emitted.len(),
                original.len()
            );
        }
    }

    /// 极端 stress：所有可能的切点都验证一次（穷举）
    #[test]
    fn stress_all_split_points_reconstruct() {
        let original: Vec<u8> = b"\x1b[41m\xe4\xb8\xad\xe6\x96\x87\x1b[0m \xf0\x9f\x98\x80 ok"
            .iter()
            .copied()
            .collect();

        for split_at in 0..=original.len() {
            let (first, second) = original.split_at(split_at);
            let mut pending: Vec<u8> = first.to_vec();
            let safe1 = safe_emit_boundary(&pending);
            let mut emitted: Vec<u8> = pending[..safe1].to_vec();
            pending.drain(..safe1);
            pending.extend_from_slice(second);
            let safe2 = safe_emit_boundary(&pending);
            emitted.extend_from_slice(&pending[..safe2]);
            pending.drain(..safe2);
            emitted.extend_from_slice(&pending);

            assert_eq!(emitted, original, "mismatch at split_at={split_at}");
        }
    }

    /// 不变量：emit 的安全前缀本身必须是合法 UTF-8（不含尾部不完整序列）
    #[test]
    fn invariant_emitted_prefix_is_valid_utf8_tail() {
        let cases: &[&[u8]] = &[
            b"\xe4\xb8\xad\xe6\x96", // 中 + 文截断
            b"\x1b[41m\xe4\xb8",     // 中截断
            b"\xf0\x9f\x98",         // emoji 截断
            b"\x1b[41m text \x1b[",  // CSI 截断
        ];
        for case in cases {
            let safe = safe_emit_boundary(case);
            // 前缀的尾部必须是 UTF-8 完整（不含 trailing incomplete 序列）
            let prefix = &case[..safe];
            // 用 from_utf8 检查"尾部不完整"错误是否消失
            if let Err(e) = std::str::from_utf8(prefix) {
                // 允许 mid-stream invalid byte（error_len = Some），但不允许 trailing incomplete (None)
                assert!(
                    e.error_len().is_some(),
                    "safe prefix still has trailing-incomplete UTF-8: {:?}",
                    prefix
                );
            }
        }
    }
}
