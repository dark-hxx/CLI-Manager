//! 系统提交（commit）压力预警。
//!
//! 提交上限 = 物理内存 + 页面文件。提交耗尽时新的分配直接失败，WebView2 等进程随之崩溃，
//! 而物理内存占用率可能还远未见顶，所以单看“内存占用”无法提前发现。
//! 后台线程定期读取系统提交，越过 85% / 95% 时各向主窗口提醒一次（`system-commit-pressure` 事件），
//! 回落到阈值以下 5 个百分点后才重新武装，避免在阈值附近抖动时反复弹出。

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

use crate::crash_reporter::{self, SystemCommit};

pub(crate) const COMMIT_PRESSURE_EVENT: &str = "system-commit-pressure";
// 启动后先等前端挂好监听再开始检查，否则启动时已处于高压的那次提醒会丢失。
const STARTUP_DELAY: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_secs(10);
const HIGH_PERCENT: f64 = 85.0;
const CRITICAL_PERCENT: f64 = 95.0;
const REARM_MARGIN_PERCENT: f64 = 5.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
enum PressureLevel {
    Normal,
    High,
    Critical,
}

fn level_for(percent: f64) -> PressureLevel {
    if percent >= CRITICAL_PERCENT {
        PressureLevel::Critical
    } else if percent >= HIGH_PERCENT {
        PressureLevel::High
    } else {
        PressureLevel::Normal
    }
}

// 返回新的已提醒级别与本次要发出的提醒：升到更高级别才提醒，回落超过余量才降低已提醒级别。
fn advance(notified: PressureLevel, percent: f64) -> (PressureLevel, Option<PressureLevel>) {
    let current = level_for(percent);
    if current > notified {
        return (current, Some(current));
    }
    (
        notified.min(level_for(percent + REARM_MARGIN_PERCENT)),
        None,
    )
}

fn commit_percent(commit: SystemCommit) -> Option<f64> {
    (commit.limit_bytes > 0)
        .then(|| commit.committed_bytes as f64 * 100.0 / commit.limit_bytes as f64)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitPressurePayload {
    level: PressureLevel,
    committed_bytes: u64,
    limit_bytes: u64,
    percent: f64,
}

/// 启动提交压力监测线程，随进程退出结束；读不到计数器时静默跳过该轮。
pub(crate) fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("commit-pressure".to_string())
        .spawn(move || {
            std::thread::sleep(STARTUP_DELAY);
            let mut notified = PressureLevel::Normal;
            loop {
                if let Some(commit) = crash_reporter::system_commit() {
                    if let Some(percent) = commit_percent(commit) {
                        let (next, alert) = advance(notified, percent);
                        if next < notified {
                            log::info!("system commit pressure eased to {percent:.1}%");
                        }
                        notified = next;
                        if let Some(level) = alert {
                            log::warn!(
                                "system commit pressure {level:?}: {} / {} bytes ({percent:.1}%)",
                                commit.committed_bytes,
                                commit.limit_bytes
                            );
                            let payload = CommitPressurePayload {
                                level,
                                committed_bytes: commit.committed_bytes,
                                limit_bytes: commit.limit_bytes,
                                percent,
                            };
                            if let Err(err) = app.emit_to("main", COMMIT_PRESSURE_EVENT, payload) {
                                log::warn!("commit pressure event emit failed: {err}");
                            }
                        }
                    }
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        });
    if let Err(err) = spawned {
        log::warn!("commit pressure monitor not started: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alerts_once_per_level_and_rearms_after_margin() {
        let mut notified = PressureLevel::Normal;
        let mut alerts = Vec::new();
        for percent in [
            70.0, 86.0, 88.0, 84.0, 86.0, 96.0, 97.0, 92.0, 96.0, 79.0, 86.0,
        ] {
            let (next, alert) = advance(notified, percent);
            notified = next;
            alerts.extend(alert);
        }
        assert_eq!(
            alerts,
            vec![
                PressureLevel::High,
                PressureLevel::Critical,
                PressureLevel::High,
            ]
        );
    }

    #[test]
    fn critical_rearms_after_dropping_below_margin() {
        let (notified, _) = advance(PressureLevel::Normal, 96.0);
        let (notified, alert) = advance(notified, 89.0);
        assert_eq!(notified, PressureLevel::High);
        assert_eq!(alert, None);
        assert_eq!(advance(notified, 95.5).1, Some(PressureLevel::Critical));
    }

    #[test]
    fn missing_limit_has_no_percent() {
        assert_eq!(
            commit_percent(SystemCommit {
                committed_bytes: 1,
                limit_bytes: 0,
            }),
            None
        );
    }
}
