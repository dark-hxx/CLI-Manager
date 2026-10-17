//! 狀態列用的設定與額度：方案額度的時間窗、權限模式與模型的顯示名稱。

use crate::{event::Limit, text::number};
use serde_json::Value;

/// 方案額度：`rate_limits.primary`／`secondary`（`used_percent`、`window_minutes`、`resets_at`）。
/// 較早的版本以 `resets_in_seconds` 表示距離重設的秒數（依該行時間換算），更早的版本把欄位攤平成
/// `primary_used_percent` 等。只採用 Codex 主要額度（`limit_id` 為 `codex` 或未提供）。
pub(super) fn rate_limits(value: &Value, observed_ms: Option<u64>) -> Vec<Limit> {
    if !value.is_object() || value["limit_id"].as_str().is_some_and(|id| id != "codex") {
        return Vec::new();
    }
    let mut limits = Vec::new();
    for slot in ["primary", "secondary"] {
        let window = &value[slot];
        let (used, minutes, resets_at, resets_in) = if window.is_object() {
            (
                &window["used_percent"],
                &window["window_minutes"],
                &window["resets_at"],
                &window["resets_in_seconds"],
            )
        } else {
            (
                &value[format!("{slot}_used_percent").as_str()],
                &value[format!("{slot}_window_minutes").as_str()],
                &Value::Null,
                &value[format!("{slot}_resets_in_seconds").as_str()],
            )
        };
        let Some(used) = used.as_f64().filter(|used| used.is_finite()) else {
            continue;
        };
        let window_minutes = number(minutes);
        let resets_at = epoch_seconds(resets_at).or_else(|| {
            let seconds = resets_in
                .as_f64()
                .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)?;
            Some(observed_ms? / 1000 + seconds.round() as u64)
        });
        limits.push(Limit {
            kind: match window_minutes {
                Some(295..=305) => "five_hour".into(),
                Some(10_050..=10_110) => "seven_day".into(),
                _ => slot.into(),
            },
            used_percent: used.clamp(0.0, 100.0),
            resets_at,
            window_minutes,
        });
    }
    limits.sort_by_key(|limit| limit.window_minutes.unwrap_or(u64::MAX));
    limits
}

/// Unix 秒；毫秒值換算成秒。
fn epoch_seconds(value: &Value) -> Option<u64> {
    let raw = value.as_f64().filter(|raw| raw.is_finite() && *raw > 0.0)?;
    Some(if raw > 1e12 { raw / 1000.0 } else { raw }.round() as u64)
}

/// Unix 毫秒；秒值換算成毫秒。
pub(super) fn epoch_ms(value: &Value) -> Option<u64> {
    let raw = number(value)?;
    Some(if raw < 100_000_000_000 {
        raw * 1000
    } else {
        raw
    })
}

/// 對應 Codex 權限選單的名稱：完全訪問、自動審查、唯讀；其餘照審批策略（on-request 等）。
pub(super) fn permission_mode(
    approval: Option<&str>,
    sandbox: Option<&str>,
    reviewer: Option<&str>,
) -> Option<String> {
    let mode = match (sandbox, reviewer) {
        (Some("danger-full-access"), _) => "full-access",
        (_, Some("auto_review")) => "auto-review",
        (Some("read-only"), _) => "read-only",
        _ => approval?,
    };
    Some(mode.to_string())
}

/// 新版的設定事件只寫 permission_profile：disabled 是完全訪問；managed 看有沒有可寫的路徑。
pub(super) fn profile_sandbox(profile: &Value) -> Option<String> {
    let sandbox = match profile["type"].as_str()? {
        "disabled" => "danger-full-access",
        "managed" => {
            let entries = profile["file_system"]["entries"].as_array()?;
            if entries.iter().any(|entry| entry["access"] == "write") {
                "workspace-write"
            } else {
                "read-only"
            }
        }
        _ => return None,
    };
    Some(sandbox.to_string())
}

/// 模型的顯示名稱：gpt-5.1-codex-max → GPT-5.1-Codex-Max；其他命名原樣保留。
pub(super) fn model_name(model: &str) -> String {
    let Some(rest) = model.strip_prefix("gpt-") else {
        return model.into();
    };
    let parts = rest.split('-').map(|part| {
        let mut characters = part.chars();
        match characters.next() {
            Some(first) if first.is_ascii_alphabetic() => {
                first.to_ascii_uppercase().to_string() + characters.as_str()
            }
            _ => part.to_string(),
        }
    });
    std::iter::once("GPT".to_string())
        .chain(parts)
        .collect::<Vec<_>>()
        .join("-")
}
