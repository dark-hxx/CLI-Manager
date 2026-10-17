use super::*;

const T: &str = "2026-10-15T07:15:26.280Z";

#[test]
fn timestamps_parse_rfc3339() {
    for (text, expected) in [
        (T, 1_792_048_526_280),
        ("2026-10-15T15:15:26.280+08:00", 1_792_048_526_280),
        ("2026-10-15T07:15:26.280123Z", 1_792_048_526_280),
        ("2026-10-15T07:15:26.2Z", 1_792_048_526_200),
        ("2026-10-15T07:15:26+0800", 1_792_019_726_000),
        ("2024-02-29T23:59:59.999-05:30", 1_709_270_999_999),
        ("2000-03-01T00:00:00Z", 951_868_800_000),
        ("1970-01-01t00:00:00z", 0),
    ] {
        assert_eq!(parse_timestamp(text), Some(expected), "{text}");
    }
    for text in [
        "",
        "garbage",
        "2026-10-15T07:15:26",
        "2026-10-15T07:15:26.Z",
        "2026-13-01T00:00:00Z",
        "2026-02-29T00:00:00Z",
        "2026-10-15T24:00:00Z",
        "2026-10-15T07:15:26Z trailing",
        "1969-12-31T23:59:59Z",
        "2026-10-15T07:15:26+25:00",
    ] {
        assert_eq!(parse_timestamp(text), None, "{text}");
    }
}

#[test]
fn text_helpers_strip_and_truncate() {
    assert_eq!(
        strip_ansi("\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}ok\u{1b}(B done\r\nnext\rover\u{8}"),
        "red ok done\nnext\nover"
    );
    assert_eq!(
        strip_reminders("a<system-reminder>x</system-reminder> b <system-reminder>open"),
        "a b"
    );
    assert_eq!(keep_head("新加坡", 2), "新加…");
    assert_eq!(keep_head("新加坡", 3), "新加坡");
    assert_eq!(keep_tail("新加坡", 2), "…加坡");
    assert_eq!(keep_tail("新加坡", 5), "新加坡");
}

#[test]
fn styled_output_whitelists_sgr_and_drops_other_controls() {
    // 游標移動、清行、私有模式、OSC 超連結、閃爍與不認得的參數都去掉；超出範圍的色號略過；
    // 24 位元色與冒號子參數改寫成分號的寫法；空參數視為重設。
    assert_eq!(
        styled_output(
            "\u{1b}[2K\u{1b}[1A\u{1b}[?25l\u{1b}]8;;https://x.test\u{7}link\u{1b}]8;;\u{7} \u{1b}[5;53;1mbold\u{1b}[m \u{1b}[38;2;215;119;87mrgb\u{1b}[38:2::1:2:3m colon\u{1b}[48;5;17;38;5;300m bg\u{1b}[4:3m under\u{1b}[4:0m\u{1b}[;7mrev\r\nnext",
            100
        )
        .as_deref(),
        Some("link \u{1b}[1mbold\u{1b}[0m \u{1b}[38;2;215;119;87mrgb\u{1b}[38;2;1;2;3m colon\u{1b}[48;5;17m bg\u{1b}[4m under\u{1b}[24m\u{1b}[0;7mrev\nnext")
    );
    // 開頭的空行去掉、第一行的縮排與它前面的樣式照原本的順序保留；結尾的空白與重設去掉。
    assert_eq!(
        styled_output(
            "\n  \n\u{1b}[44m  \u{1b}[1mtitle\u{1b}[0m  \n\u{1b}[0m",
            100
        )
        .as_deref(),
        Some("\u{1b}[44m  \u{1b}[1mtitle")
    );
    // 超過上限時在可見字元數處截斷，補上重設與「…」。
    assert_eq!(
        styled_output("\u{1b}[31m新加坡\u{1b}[0m", 2).as_deref(),
        Some("\u{1b}[31m新加\u{1b}[0m…")
    );
    // 沒有樣式（只有重設或其他控制序列）時不給帶樣式的版本。
    assert_eq!(styled_output("\u{1b}[0mplain\u{1b}[2J\u{1b}[m", 100), None);
    assert_eq!(styled_output("\u{1b}[31m\u{1b}[0m   ", 100), None);
    assert_eq!(styled_output("\u{1b}[6;25;99mblink", 100), None);
}
