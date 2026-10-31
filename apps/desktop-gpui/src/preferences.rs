use crate::exit::ExitBehavior;
use crate::keymap::Keymap;
use cli_manager_core_prefs::{settings::Settings, PrefsFile, PrefsStore};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestoreMode {
    Ask,
    Auto,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InterfaceLanguage {
    ZhCn,
    ZhTw,
    EnUs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppTheme {
    Dark,
    Light,
}

impl InterfaceLanguage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ZhCn => "zh-CN",
            Self::ZhTw => "zh-TW",
            Self::EnUs => "en-US",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartupPreferences {
    pub language: InterfaceLanguage,
    pub theme: AppTheme,
    pub restore_enabled: bool,
    pub restore_mode: RestoreMode,
    pub exit_behavior: ExitBehavior,
    pub background_include_finished: bool,
    pub keymap: Keymap,
}

impl Default for StartupPreferences {
    fn default() -> Self {
        Self {
            language: InterfaceLanguage::ZhCn,
            theme: AppTheme::Light,
            restore_enabled: true,
            restore_mode: RestoreMode::Ask,
            exit_behavior: ExitBehavior::Ask,
            background_include_finished: false,
            keymap: Keymap::default(),
        }
    }
}

fn root(database: Option<&Path>) -> Result<PathBuf, String> {
    let database = match database {
        Some(path) => path.to_owned(),
        None => crate::paths::database_path()?,
    };
    database
        .parent()
        .map(Path::to_owned)
        .ok_or_else(|| "settings data root unavailable".to_owned())
}

pub fn load(database: Option<&Path>) -> StartupPreferences {
    let Ok(root) = root(database) else {
        return StartupPreferences::default();
    };
    let Ok(settings) = PrefsStore::new(root).load::<Settings>(PrefsFile::SETTINGS) else {
        return StartupPreferences::default();
    };
    let language = match settings.get("language").and_then(|value| value.as_str()) {
        Some("en-US") => InterfaceLanguage::EnUs,
        Some("zh-TW") => InterfaceLanguage::ZhTw,
        _ => InterfaceLanguage::ZhCn,
    };
    let theme = match settings.get("theme").and_then(|value| value.as_str()) {
        Some("dark") => AppTheme::Dark,
        Some("light") => AppTheme::Light,
        _ => AppTheme::Light,
    };
    let restore_enabled = settings
        .get("terminalSessionRestoreEnabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let restore_mode = match settings
        .get("terminalSessionRestoreMode")
        .and_then(|value| value.as_str())
    {
        Some("auto") => RestoreMode::Auto,
        _ => RestoreMode::Ask,
    };
    let exit_behavior = match settings
        .get("exitWithRunningTasksBehavior")
        .and_then(|value| value.as_str())
    {
        Some("background") => ExitBehavior::Background,
        Some("minimize") => ExitBehavior::Minimize,
        Some("discard") => ExitBehavior::Discard,
        _ => ExitBehavior::Ask,
    };
    let background_include_finished = settings
        .get("backgroundIncludeFinishedTasks")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let keymap = Keymap::from_settings(settings.get("keyboardShortcuts"));
    StartupPreferences {
        language,
        theme,
        restore_enabled,
        restore_mode,
        exit_behavior,
        background_include_finished,
        keymap,
    }
}

pub fn save_language(database: Option<&Path>, language: InterfaceLanguage) -> Result<(), String> {
    let root = root(database)?;
    PrefsStore::new(root)
        .update::<Settings, _>(PrefsFile::SETTINGS, |settings| {
            settings.set(
                "language",
                serde_json::Value::String(language.as_str().to_owned()),
            );
        })
        .map_err(|error| error.to_string())
}

pub fn save_theme(database: Option<&Path>, theme: AppTheme) -> Result<(), String> {
    let root = root(database)?;
    PrefsStore::new(root)
        .update::<Settings, _>(PrefsFile::SETTINGS, |settings| {
            settings.set(
                "theme",
                serde_json::Value::String(
                    match theme {
                        AppTheme::Dark => "dark",
                        AppTheme::Light => "light",
                    }
                    .to_owned(),
                ),
            );
        })
        .map_err(|error| error.to_string())
}

pub fn save_runtime_settings(
    database: Option<&Path>,
    restore_enabled: bool,
    restore_mode: RestoreMode,
    exit_behavior: ExitBehavior,
    background_include_finished: bool,
) -> Result<(), String> {
    let root = root(database)?;
    PrefsStore::new(root)
        .update::<Settings, _>(PrefsFile::SETTINGS, |settings| {
            settings.set("terminalSessionRestoreEnabled", restore_enabled.into());
            settings.set(
                "terminalSessionRestoreMode",
                serde_json::Value::String(
                    match restore_mode {
                        RestoreMode::Ask => "ask",
                        RestoreMode::Auto => "auto",
                    }
                    .to_owned(),
                ),
            );
            settings.set(
                "exitWithRunningTasksBehavior",
                serde_json::Value::String(
                    match exit_behavior {
                        ExitBehavior::Ask => "ask",
                        ExitBehavior::Background => "background",
                        ExitBehavior::Minimize => "minimize",
                        ExitBehavior::Discard => "discard",
                    }
                    .to_owned(),
                ),
            );
            settings.set(
                "backgroundIncludeFinishedTasks",
                background_include_finished.into(),
            );
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn invalid_or_missing_restore_settings_use_safe_defaults() {
        let directory = tempdir().unwrap();
        assert_eq!(
            load(Some(&directory.path().join("missing.db"))),
            StartupPreferences::default()
        );
        fs::write(directory.path().join("settings.json"), r#"{"terminalSessionRestoreEnabled":false,"terminalSessionRestoreMode":"bad","exitWithRunningTasksBehavior":"background","backgroundIncludeFinishedTasks":true}"#).unwrap();
        assert_eq!(
            load(Some(&directory.path().join("data.db"))),
            StartupPreferences {
                language: InterfaceLanguage::ZhCn,
                theme: AppTheme::Light,
                restore_enabled: false,
                restore_mode: RestoreMode::Ask,
                exit_behavior: ExitBehavior::Background,
                background_include_finished: true,
                keymap: Keymap::default()
            }
        );
    }

    #[test]
    fn language_is_loaded_and_saved_without_losing_unknown_settings() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("data.db");
        fs::write(
            directory.path().join("settings.json"),
            r#"{"language":"en-US","futureFlag":{"enabled":true}}"#,
        )
        .unwrap();
        assert_eq!(load(Some(&database)).language, InterfaceLanguage::EnUs);
        save_language(Some(&database), InterfaceLanguage::ZhCn).unwrap();
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["language"], "zh-CN");
        assert_eq!(settings["futureFlag"]["enabled"], true);
    }

    #[test]
    fn theme_is_loaded_and_saved_without_losing_unknown_settings() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("data.db");
        fs::write(
            directory.path().join("settings.json"),
            r#"{"theme":"light","futureFlag":true}"#,
        )
        .unwrap();
        assert_eq!(load(Some(&database)).theme, AppTheme::Light);
        save_theme(Some(&database), AppTheme::Dark).unwrap();
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["futureFlag"], true);
    }

    #[test]
    fn dark_theme_is_restored_from_persisted_settings() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("data.db");
        fs::write(
            directory.path().join("settings.json"),
            r#"{"theme":"dark"}"#,
        )
        .unwrap();
        assert_eq!(load(Some(&database)).theme, AppTheme::Dark);
    }

    #[test]
    fn runtime_settings_round_trip_preserves_unknown_settings() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("data.db");
        fs::write(
            directory.path().join("settings.json"),
            r#"{"futureFlag":"keep"}"#,
        )
        .unwrap();
        save_runtime_settings(
            Some(&database),
            false,
            RestoreMode::Auto,
            ExitBehavior::Discard,
            true,
        )
        .unwrap();
        let loaded = load(Some(&database));
        assert!(!loaded.restore_enabled);
        assert_eq!(loaded.restore_mode, RestoreMode::Auto);
        assert_eq!(loaded.exit_behavior, ExitBehavior::Discard);
        assert!(loaded.background_include_finished);
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["futureFlag"], "keep");
    }
}
