use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// 完整偏好文档，键名与 Tauri store 一致；按领域接入时再增加强类型访问器。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Settings {
    values: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            values: serde_json::from_str(include_str!("../fixtures/settings-defaults.json"))
                .expect("generated settings defaults must be a JSON object"),
        }
    }
}

impl<'de> Deserialize<'de> for Settings {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let stored = Map::<String, Value>::deserialize(deserializer)?;
        let mut settings = Self::default();
        // 默认值只填补缺失的顶层键；保留 null 和嵌套对象原文，领域迁移负责进一步规范化。
        settings.values.extend(stored);
        Ok(settings)
    }
}

impl Settings {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    pub fn set(&mut self, key: impl Into<String>, value: Value) {
        self.values.insert(key.into(), value);
    }

    pub fn values(&self) -> &Map<String, Value> {
        &self.values
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_generated_frontend_document() {
        let expected: Value =
            serde_json::from_str(include_str!("../fixtures/settings-defaults.json")).unwrap();
        assert_eq!(serde_json::to_value(Settings::default()).unwrap(), expected);
        assert_eq!(Settings::default().values().len(), 125);
    }

    #[test]
    fn missing_keys_use_defaults_and_unknown_nested_values_survive() {
        let source = serde_json::json!({
            "language": "en-US", "future": {"nested": [null, "中文", 42]},
            "desktopPet": {"futureField": true}, "systemNotificationSoundPath": null,
        });
        let settings: Settings = serde_json::from_value(source.clone()).unwrap();
        assert_eq!(settings.get("theme"), Some(&Value::String("light".into())));
        let output = serde_json::to_value(settings).unwrap();
        for (key, value) in source.as_object().unwrap() {
            assert_eq!(&output[key], value);
        }
        assert!(serde_json::from_str::<Settings>("[]").is_err());
    }
}
