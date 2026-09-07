pub(super) type PowerlinePalette = (&'static [&'static str], &'static [&'static str]);

struct PowerlineThemePalettes {
    ansi16: PowerlinePalette,
    ansi256: PowerlinePalette,
    truecolor: PowerlinePalette,
}

pub(super) fn powerline_theme(name: &str, color_level: u8) -> Option<PowerlinePalette> {
    let palettes = match name {
        "nord" => PowerlineThemePalettes {
            ansi16: (
                &["black", "brightWhite", "brightWhite", "black", "black"],
                &[
                    "bgBrightCyan",
                    "bgBrightBlack",
                    "bgBlue",
                    "bgBrightYellow",
                    "bgBrightGreen",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:16",
                    "ansi256:254",
                    "ansi256:231",
                    "ansi256:231",
                    "ansi256:16",
                ],
                &[
                    "ansi256:73",
                    "ansi256:239",
                    "ansi256:25",
                    "ansi256:96",
                    "ansi256:152",
                ],
            ),
            truecolor: (
                &[
                    "hex:2E3440",
                    "hex:D8DEE9",
                    "hex:FDF6E3",
                    "hex:2E3440",
                    "hex:2E3440",
                ],
                &[
                    "hex:88C0D0",
                    "hex:4C566A",
                    "hex:5E81AC",
                    "hex:B48EAD",
                    "hex:A3BE8C",
                ],
            ),
        },
        "nord-aurora" => PowerlineThemePalettes {
            ansi16: (
                &["brightWhite", "black", "black", "black", "black"],
                &[
                    "bgRed",
                    "bgBrightYellow",
                    "bgBrightBlue",
                    "bgGreen",
                    "bgBrightMagenta",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:231",
                    "ansi256:16",
                    "ansi256:231",
                    "ansi256:16",
                    "ansi256:16",
                ],
                &[
                    "ansi256:131",
                    "ansi256:220",
                    "ansi256:68",
                    "ansi256:108",
                    "ansi256:176",
                ],
            ),
            truecolor: (
                &[
                    "hex:ECEFF4",
                    "hex:2E3440",
                    "hex:FDF6E3",
                    "hex:2E3440",
                    "hex:2E3440",
                ],
                &[
                    "hex:BF616A",
                    "hex:EBCB8B",
                    "hex:5E81AC",
                    "hex:A3BE8C",
                    "hex:B48EAD",
                ],
            ),
        },
        "monokai" => PowerlineThemePalettes {
            ansi16: (
                &["black", "brightWhite", "black", "white", "black"],
                &[
                    "bgBrightGreen",
                    "bgBrightBlack",
                    "bgBrightYellow",
                    "bgMagenta",
                    "bgBrightCyan",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:235",
                    "ansi256:255",
                    "ansi256:235",
                    "ansi256:16",
                    "ansi256:235",
                ],
                &[
                    "ansi256:148",
                    "ansi256:238",
                    "ansi256:186",
                    "ansi256:141",
                    "ansi256:81",
                ],
            ),
            truecolor: (
                &[
                    "hex:272822",
                    "hex:F8F8F2",
                    "hex:272822",
                    "hex:272822",
                    "hex:272822",
                ],
                &[
                    "hex:A6E22E",
                    "hex:49483E",
                    "hex:E6DB74",
                    "hex:AE81FF",
                    "hex:66D9EF",
                ],
            ),
        },
        "solarized" => PowerlineThemePalettes {
            ansi16: (
                &["brightWhite", "black", "brightWhite", "black", "black"],
                &[
                    "bgBlue",
                    "bgBrightYellow",
                    "bgBrightBlack",
                    "bgCyan",
                    "bgBrightWhite",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:231",
                    "ansi256:234",
                    "ansi256:254",
                    "ansi256:16",
                    "ansi256:234",
                ],
                &[
                    "ansi256:33",
                    "ansi256:136",
                    "ansi256:240",
                    "ansi256:37",
                    "ansi256:254",
                ],
            ),
            truecolor: (
                &[
                    "hex:073642",
                    "hex:073642",
                    "hex:FDF6E3",
                    "hex:073642",
                    "hex:073642",
                ],
                &[
                    "hex:268BD2",
                    "hex:B58900",
                    "hex:586E75",
                    "hex:2AA198",
                    "hex:EEE8D5",
                ],
            ),
        },
        "minimal" => PowerlineThemePalettes {
            ansi16: (
                &["brightWhite", "black", "white", "black", "black"],
                &[
                    "bgBrightBlack",
                    "bgBrightWhite",
                    "bgBlack",
                    "bgWhite",
                    "bgBrightWhite",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:255",
                    "ansi256:232",
                    "ansi256:255",
                    "ansi256:232",
                    "ansi256:252",
                ],
                &[
                    "ansi256:240",
                    "ansi256:251",
                    "ansi256:233",
                    "ansi256:248",
                    "ansi256:236",
                ],
            ),
            truecolor: (
                &[
                    "hex:FFFFFF",
                    "hex:1C1C1C",
                    "hex:FFFFFF",
                    "hex:1C1C1C",
                    "hex:E4E4E4",
                ],
                &[
                    "hex:585858",
                    "hex:D0D0D0",
                    "hex:1A1A1A",
                    "hex:A8A8A8",
                    "hex:303030",
                ],
            ),
        },
        "dracula" => PowerlineThemePalettes {
            ansi16: (
                &["brightWhite", "black", "brightWhite", "black", "white"],
                &[
                    "bgMagenta",
                    "bgBrightWhite",
                    "bgRed",
                    "bgBrightCyan",
                    "bgBrightBlack",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:235",
                    "ansi256:235",
                    "ansi256:235",
                    "ansi256:235",
                    "ansi256:231",
                ],
                &[
                    "ansi256:141",
                    "ansi256:253",
                    "ansi256:204",
                    "ansi256:117",
                    "ansi256:236",
                ],
            ),
            truecolor: (
                &[
                    "hex:282A36",
                    "hex:282A36",
                    "hex:282A36",
                    "hex:282A36",
                    "hex:F8F8F2",
                ],
                &[
                    "hex:BD93F9",
                    "hex:F8F8F2",
                    "hex:FF5555",
                    "hex:8BE9FD",
                    "hex:44475A",
                ],
            ),
        },
        "catppuccin" => PowerlineThemePalettes {
            ansi16: (
                &["black", "brightWhite", "black", "brightWhite", "black"],
                &[
                    "bgBrightMagenta",
                    "bgBrightBlack",
                    "bgBrightGreen",
                    "bgBlue",
                    "bgBrightYellow",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:235",
                    "ansi256:255",
                    "ansi256:235",
                    "ansi256:235",
                    "ansi256:235",
                ],
                &[
                    "ansi256:176",
                    "ansi256:238",
                    "ansi256:150",
                    "ansi256:210",
                    "ansi256:111",
                ],
            ),
            truecolor: (
                &[
                    "hex:1E1E2E",
                    "hex:CDD6F4",
                    "hex:1E1E2E",
                    "hex:1E1E2E",
                    "hex:CDD6F4",
                ],
                &[
                    "hex:CBA6F7",
                    "hex:45475A",
                    "hex:A6E3A1",
                    "hex:F38BA8",
                    "hex:585B70",
                ],
            ),
        },
        "gruvbox" => PowerlineThemePalettes {
            ansi16: (
                &["brightWhite", "black", "black", "brightWhite", "black"],
                &[
                    "bgRed",
                    "bgBrightYellow",
                    "bgBrightWhite",
                    "bgBlue",
                    "bgBrightGreen",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:16",
                    "ansi256:235",
                    "ansi256:235",
                    "ansi256:16",
                    "ansi256:235",
                ],
                &[
                    "ansi256:167",
                    "ansi256:214",
                    "ansi256:246",
                    "ansi256:109",
                    "ansi256:142",
                ],
            ),
            truecolor: (
                &[
                    "hex:EBDBB2",
                    "hex:282828",
                    "hex:282828",
                    "hex:FDF6E3",
                    "hex:282828",
                ],
                &[
                    "hex:CC241D",
                    "hex:FABD2F",
                    "hex:A89984",
                    "hex:458588",
                    "hex:98971A",
                ],
            ),
        },
        "onedark" => PowerlineThemePalettes {
            ansi16: (
                &["black", "brightWhite", "black", "brightWhite", "black"],
                &[
                    "bgBrightBlue",
                    "bgBrightBlack",
                    "bgBrightGreen",
                    "bgRed",
                    "bgBrightYellow",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:235",
                    "ansi256:251",
                    "ansi256:235",
                    "ansi256:16",
                    "ansi256:235",
                ],
                &[
                    "ansi256:75",
                    "ansi256:237",
                    "ansi256:114",
                    "ansi256:204",
                    "ansi256:180",
                ],
            ),
            truecolor: (
                &[
                    "hex:282C34",
                    "hex:ABB2BF",
                    "hex:282C34",
                    "hex:282C34",
                    "hex:282C34",
                ],
                &[
                    "hex:61AFEF",
                    "hex:3E4452",
                    "hex:98C379",
                    "hex:E06C75",
                    "hex:E5C07B",
                ],
            ),
        },
        "tokyonight" => PowerlineThemePalettes {
            ansi16: (
                &["brightWhite", "black", "brightWhite", "black", "black"],
                &[
                    "bgBlue",
                    "bgBrightWhite",
                    "bgMagenta",
                    "bgBrightYellow",
                    "bgBrightCyan",
                ],
            ),
            ansi256: (
                &[
                    "ansi256:16",
                    "ansi256:234",
                    "ansi256:16",
                    "ansi256:234",
                    "ansi256:234",
                ],
                &[
                    "ansi256:111",
                    "ansi256:248",
                    "ansi256:176",
                    "ansi256:221",
                    "ansi256:80",
                ],
            ),
            truecolor: (
                &[
                    "hex:1A1B26",
                    "hex:1A1B26",
                    "hex:1A1B26",
                    "hex:1A1B26",
                    "hex:1A1B26",
                ],
                &[
                    "hex:7AA2F7",
                    "hex:D5D6DB",
                    "hex:BB9AF7",
                    "hex:E0AF68",
                    "hex:7DCFFF",
                ],
            ),
        },
        _ => return None,
    };
    Some(match color_level {
        2 => palettes.ansi256,
        3 => palettes.truecolor,
        _ => palettes.ansi16,
    })
}
