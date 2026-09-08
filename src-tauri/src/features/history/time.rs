use super::{system_time_to_millis, StatsTimeBounds, DAY_MS, HOUR_MS};
use serde_json::Value;
use std::time::SystemTime;

// 返回当前系统时间的 Unix 毫秒数。
pub(super) fn now_millis() -> i64 {
    system_time_to_millis(SystemTime::now())
}

// 取得正时间戳所在 UTC 日的起点，非正值返回零。
pub(super) fn day_start_utc(ts: i64) -> i64 {
    if ts <= 0 {
        return 0;
    }
    ts - (ts % DAY_MS)
}

// 取得正时间戳对应的 UTC 小时，非正值返回零。
pub(super) fn hour_of_day_utc(ts: i64) -> usize {
    if ts <= 0 {
        return 0;
    }
    let normalized = ((ts % DAY_MS) + DAY_MS) % DAY_MS;
    (normalized / HOUR_MS) as usize
}

// 按显式统计起点的日偏移或默认 UTC 规则计算小时桶。
pub(super) fn hour_of_day_for_stats(ts: i64, bounds: StatsTimeBounds) -> usize {
    if !bounds.explicit {
        return hour_of_day_utc(ts);
    }
    let normalized = (((ts - bounds.start_day) % DAY_MS) + DAY_MS) % DAY_MS;
    (normalized / HOUR_MS) as usize
}

// 按当前值与最大值的比例映射到零至四级热度。
pub(super) fn calc_heat_level(value: usize, max_value: usize) -> u8 {
    if value == 0 || max_value == 0 {
        return 0;
    }
    let ratio = value as f64 / max_value as f64;
    if ratio < 0.25 {
        1
    } else if ratio < 0.5 {
        2
    } else if ratio < 0.75 {
        3
    } else {
        4
    }
}

/// content 块全部为 tool_result 时视为工具结果行。
// 仅在非空内容数组全部为 tool_result 块时认定为工具结果消息。
pub(super) fn is_tool_result_message(value: &Value) -> bool {
    let blocks = value
        .get("message")
        .and_then(|message| message.get("content"))
        .or_else(|| value.get("content"))
        .and_then(Value::as_array);
    match blocks {
        Some(blocks) if !blocks.is_empty() => blocks
            .iter()
            .all(|block| block.get("type").and_then(Value::as_str) == Some("tool_result")),
        _ => false,
    }
}
