use crate::settings::Settings;
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorStyle {
    Bar,
    Block,
    Underline,
}

impl CursorStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bar => "bar",
            Self::Block => "block",
            Self::Underline => "underline",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TerminalPreferences {
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub scrollback_custom: bool,
    pub scrollback_rows: usize,
    pub cursor_style: CursorStyle,
}

impl Default for TerminalPreferences {
    fn default() -> Self {
        Self::from_settings(&Settings::default())
    }
}

impl TerminalPreferences {
    pub fn from_settings(settings: &Settings) -> Self {
        let number = |key: &str, default: f64, minimum: f64, maximum: f64| {
            settings
                .get(key)
                .and_then(|value| value.as_f64())
                .filter(|value| value.is_finite())
                .unwrap_or(default)
                .clamp(minimum, maximum)
        };
        Self {
            font_family: settings
                .get("fontFamily")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("Cascadia Code, Consolas, monospace")
                .to_owned(),
            font_size: number("fontSize", 14., 8., 32.),
            line_height: number("terminalLineHeight", 1., 1., 2.),
            scrollback_custom: settings
                .get("terminalScrollbackCustomEnabled")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            scrollback_rows: number("terminalScrollbackRows", 9000., 1000., 50_000.).round()
                as usize,
            cursor_style: match settings
                .get("terminalCursorStyle")
                .and_then(|value| value.as_str())
            {
                Some("block") => CursorStyle::Block,
                Some("underline") => CursorStyle::Underline,
                _ => CursorStyle::Bar,
            },
        }
    }

    pub fn write_to(&self, settings: &mut Settings) {
        settings.set("fontFamily", json!(self.font_family));
        settings.set("fontSize", json!(self.font_size));
        settings.set("terminalLineHeight", json!(self.line_height));
        settings.set(
            "terminalScrollbackCustomEnabled",
            json!(self.scrollback_custom),
        );
        settings.set("terminalScrollbackRows", json!(self.scrollback_rows));
        settings.set("terminalCursorStyle", json!(self.cursor_style.as_str()));
    }

    pub fn effective_scrollback(&self) -> usize {
        if self.scrollback_custom {
            self.scrollback_rows
        } else {
            9000
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PrefsFile, PrefsStore};

    #[test]
    fn missing_and_invalid_settings_use_compatible_defaults_and_limits() {
        let preferences = TerminalPreferences::default();
        assert_eq!(preferences.font_size, 14.);
        assert_eq!(preferences.effective_scrollback(), 9000);
        assert_eq!(preferences.cursor_style, CursorStyle::Bar);
        let settings = serde_json::from_value(json!({
            "fontFamily":" ", "fontSize":100, "terminalLineHeight":0,
            "terminalScrollbackRows":999999, "terminalScrollbackCustomEnabled":true,
            "terminalCursorStyle":"unknown"
        }))
        .unwrap();
        let preferences = TerminalPreferences::from_settings(&settings);
        assert_eq!(preferences.font_size, 32.);
        assert_eq!(preferences.line_height, 1.);
        assert_eq!(preferences.effective_scrollback(), 50_000);
        assert_eq!(
            preferences.font_family,
            "Cascadia Code, Consolas, monospace"
        );
    }

    #[test]
    fn shared_document_round_trip_preserves_other_domains_and_raw_keys() {
        let directory = tempfile::tempdir().unwrap();
        let store = PrefsStore::new(directory.path());
        store
            .update::<Settings, _>(PrefsFile::SETTINGS, |settings| {
                settings.set("future", json!({"key":[1, null]}));
                let mut value = TerminalPreferences::default();
                value.font_family = "'My Mono', Consolas, monospace".into();
                value.font_size = 18.;
                value.line_height = 1.4;
                value.scrollback_custom = true;
                value.scrollback_rows = 12000;
                value.cursor_style = CursorStyle::Underline;
                value.write_to(settings);
            })
            .unwrap();
        let settings = store.load::<Settings>(PrefsFile::SETTINGS).unwrap();
        assert_eq!(settings.get("future"), Some(&json!({"key":[1,null]})));
        assert_eq!(settings.get("fontSize"), Some(&json!(18.)));
        assert_eq!(settings.get("terminalLineHeight"), Some(&json!(1.4)));
        assert_eq!(
            settings.get("terminalCursorStyle"),
            Some(&json!("underline"))
        );
        let value = TerminalPreferences::from_settings(&settings);
        assert_eq!(value.effective_scrollback(), 12000);
        assert_eq!(value.line_height, 1.4);
        assert_eq!(value.cursor_style, CursorStyle::Underline);
    }
}
