use cli_manager_core_prefs::terminal::{CursorStyle, TerminalPreferences};
use cli_manager_term_engine::CursorShape;
use gpui::{Font, FontFallbacks};

pub(crate) fn font_descriptor(settings: &TerminalPreferences) -> Font {
    let families = font_families(&settings.font_family);
    let mut font = gpui::font(
        families
            .first()
            .cloned()
            .unwrap_or_else(|| "Consolas".into()),
    );
    font.fallbacks = Some(FontFallbacks::from_fonts(
        families.into_iter().skip(1).collect(),
    ));
    font
}

fn font_families(stack: &str) -> Vec<String> {
    let mut families = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in stack.chars() {
        match character {
            '\'' | '"' if quote == Some(character) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(character),
            ',' if quote.is_none() => {
                if !current.trim().is_empty() {
                    families.push(current.trim().to_owned());
                }
                current.clear();
            }
            _ => current.push(character),
        }
    }
    if !current.trim().is_empty() {
        families.push(current.trim().to_owned());
    }
    for family in &mut families {
        if family.eq_ignore_ascii_case("monospace") {
            *family = if cfg!(windows) {
                "Consolas"
            } else if cfg!(target_os = "macos") {
                "Menlo"
            } else {
                "monospace"
            }
            .into();
        }
    }
    families
}

pub(crate) fn cursor_shape(settings: &TerminalPreferences) -> CursorShape {
    match settings.cursor_style {
        CursorStyle::Bar => CursorShape::Beam,
        CursorStyle::Block => CursorShape::Block,
        CursorStyle::Underline => CursorShape::Underline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_font_stack_preserves_quoted_names_and_fallback_order() {
        assert_eq!(
            font_families("'My, Mono', \"Second Font\", Consolas"),
            ["My, Mono", "Second Font", "Consolas"]
        );
        let mut settings = TerminalPreferences::default();
        settings.font_family = "My Mono, Second Font".into();
        let font = font_descriptor(&settings);
        assert_eq!(font.family.as_ref(), "My Mono");
        assert_eq!(font.fallbacks.unwrap().fallback_list(), ["Second Font"]);
    }
}
