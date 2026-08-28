use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub(crate) struct CircuitPolicy {
    pub failure_threshold: u32,
    pub success_threshold: u32,
    pub timeout: Duration,
    pub error_rate_threshold: f64,
    pub min_requests: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum CircuitStatus {
    #[default]
    Closed,
    Open,
    HalfOpen,
}

impl CircuitStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Open => "open",
            Self::HalfOpen => "halfOpen",
        }
    }
}

#[derive(Debug, Default)]
struct CircuitEntry {
    status: CircuitStatus,
    consecutive_failures: u32,
    successful_probes: u32,
    requests: u32,
    failures: u32,
    opened_at: Option<Instant>,
    probe_in_flight: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CircuitSnapshot {
    pub app_type: String,
    pub provider_id: String,
    pub status: String,
    pub consecutive_failures: u32,
    pub successful_probes: u32,
}

#[derive(Debug)]
pub(crate) struct CircuitPermit {
    key: (String, String),
    probe: bool,
}

#[derive(Debug, Default)]
pub(crate) struct CircuitRegistry {
    entries: Mutex<HashMap<(String, String), CircuitEntry>>,
}

impl CircuitRegistry {
    pub(crate) fn acquire(
        &self,
        app_type: &str,
        provider_id: &str,
        policy: CircuitPolicy,
    ) -> Result<CircuitPermit, ()> {
        let key = (app_type.to_string(), provider_id.to_string());
        let mut entries = self.entries.lock().map_err(|_| ())?;
        let entry = entries.entry(key.clone()).or_default();
        if entry.status == CircuitStatus::Open {
            if entry
                .opened_at
                .is_some_and(|opened_at| opened_at.elapsed() >= policy.timeout)
            {
                entry.status = CircuitStatus::HalfOpen;
                entry.probe_in_flight = false;
                entry.successful_probes = 0;
            } else {
                return Err(());
            }
        }
        if entry.status == CircuitStatus::HalfOpen {
            if entry.probe_in_flight {
                return Err(());
            }
            entry.probe_in_flight = true;
            return Ok(CircuitPermit { key, probe: true });
        }
        Ok(CircuitPermit { key, probe: false })
    }

    pub(crate) fn record_success(&self, permit: CircuitPermit, policy: CircuitPolicy) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let Some(entry) = entries.get_mut(&permit.key) else {
            return;
        };
        if permit.probe {
            entry.probe_in_flight = false;
            entry.successful_probes = entry.successful_probes.saturating_add(1);
            if entry.successful_probes >= policy.success_threshold {
                reset_closed(entry);
            }
        } else if entry.status == CircuitStatus::Closed {
            entry.consecutive_failures = 0;
            entry.requests = entry.requests.saturating_add(1);
        }
    }

    pub(crate) fn record_failure(&self, permit: CircuitPermit, policy: CircuitPolicy) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let Some(entry) = entries.get_mut(&permit.key) else {
            return;
        };
        if permit.probe {
            entry.probe_in_flight = false;
            entry.status = CircuitStatus::Open;
            entry.opened_at = Some(Instant::now());
            entry.successful_probes = 0;
            entry.consecutive_failures = policy.failure_threshold;
            return;
        }
        if entry.status != CircuitStatus::Closed {
            return;
        }
        entry.requests = entry.requests.saturating_add(1);
        entry.failures = entry.failures.saturating_add(1);
        entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
        let error_rate = f64::from(entry.failures) / f64::from(entry.requests);
        if entry.consecutive_failures >= policy.failure_threshold
            || (entry.requests >= policy.min_requests && error_rate >= policy.error_rate_threshold)
        {
            entry.status = CircuitStatus::Open;
            entry.opened_at = Some(Instant::now());
        }
    }

    pub(crate) fn release(&self, permit: CircuitPermit) {
        if !permit.probe {
            return;
        }
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if let Some(entry) = entries.get_mut(&permit.key) {
            entry.probe_in_flight = false;
        }
    }

    pub(crate) fn reset(&self, app_type: &str, provider_id: &str) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        if provider_id.is_empty() {
            for ((app, _), entry) in entries.iter_mut() {
                if app == app_type {
                    reset_closed(entry);
                }
            }
        } else {
            if let Some(entry) = entries.get_mut(&(app_type.to_string(), provider_id.to_string())) {
                reset_closed(entry);
            }
        }
    }

    pub(crate) fn snapshots(&self) -> Vec<CircuitSnapshot> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };
        let mut snapshots: Vec<_> = entries
            .iter()
            .map(|((app_type, provider_id), entry)| CircuitSnapshot {
                app_type: app_type.clone(),
                provider_id: provider_id.clone(),
                status: entry.status.as_str().to_string(),
                consecutive_failures: entry.consecutive_failures,
                successful_probes: entry.successful_probes,
            })
            .collect();
        snapshots.sort_by(|left, right| {
            left.app_type
                .cmp(&right.app_type)
                .then_with(|| left.provider_id.cmp(&right.provider_id))
        });
        snapshots
    }
}

fn reset_closed(entry: &mut CircuitEntry) {
    entry.status = CircuitStatus::Closed;
    entry.consecutive_failures = 0;
    entry.successful_probes = 0;
    entry.requests = 0;
    entry.failures = 0;
    entry.opened_at = None;
    entry.probe_in_flight = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> CircuitPolicy {
        CircuitPolicy {
            failure_threshold: 2,
            success_threshold: 2,
            timeout: Duration::from_millis(10),
            error_rate_threshold: 0.5,
            min_requests: 4,
        }
    }

    #[test]
    fn opens_on_consecutive_failures_and_blocks_until_timeout() {
        let registry = CircuitRegistry::default();
        let policy = policy();
        let first = registry.acquire("codex", "provider-a", policy).unwrap();
        registry.record_failure(first, policy);
        let second = registry.acquire("codex", "provider-a", policy).unwrap();
        registry.record_failure(second, policy);
        assert!(registry.acquire("codex", "provider-a", policy).is_err());
        assert_eq!(registry.snapshots()[0].status, "open");
    }

    #[test]
    fn half_open_allows_one_probe_and_closes_after_success_threshold() {
        let registry = CircuitRegistry::default();
        let policy = CircuitPolicy {
            timeout: Duration::ZERO,
            ..policy()
        };
        for _ in 0..2 {
            let permit = registry.acquire("claude", "provider-a", policy).unwrap();
            registry.record_failure(permit, policy);
        }
        let probe = registry.acquire("claude", "provider-a", policy).unwrap();
        assert!(registry.acquire("claude", "provider-a", policy).is_err());
        registry.record_success(probe, policy);
        let probe = registry.acquire("claude", "provider-a", policy).unwrap();
        registry.record_success(probe, policy);
        assert_eq!(registry.snapshots()[0].status, "closed");
    }

    #[test]
    fn reset_can_clear_one_provider_or_all_app_circuits() {
        let registry = CircuitRegistry::default();
        let policy = policy();
        for provider in ["a", "b"] {
            let permit = registry.acquire("grokbuild", provider, policy).unwrap();
            registry.record_failure(permit, policy);
        }
        for _ in 0..2 {
            let permit = registry.acquire("codex", "other-app", policy).unwrap();
            registry.record_failure(permit, policy);
        }
        registry.reset("grokbuild", "a");
        assert_eq!(registry.snapshots().len(), 3);
        assert_eq!(
            registry
                .snapshots()
                .into_iter()
                .find(|snapshot| snapshot.provider_id == "a")
                .unwrap()
                .status,
            "closed"
        );
        registry.reset("grokbuild", "");
        assert!(registry
            .snapshots()
            .into_iter()
            .filter(|snapshot| snapshot.app_type == "grokbuild")
            .all(|snapshot| snapshot.status == "closed"));
        assert_eq!(
            registry
                .snapshots()
                .into_iter()
                .find(|snapshot| snapshot.app_type == "codex")
                .unwrap()
                .status,
            "open"
        );
    }

    #[test]
    fn neutral_release_clears_half_open_probe_without_counting_failure() {
        let registry = CircuitRegistry::default();
        let policy = CircuitPolicy {
            timeout: Duration::ZERO,
            ..policy()
        };
        for _ in 0..2 {
            let permit = registry.acquire("claude", "provider-a", policy).unwrap();
            registry.record_failure(permit, policy);
        }
        let probe = registry.acquire("claude", "provider-a", policy).unwrap();
        registry.release(probe);
        assert!(registry.acquire("claude", "provider-a", policy).is_ok());
        assert_eq!(registry.snapshots()[0].status, "halfOpen");
    }

    #[test]
    fn restart_starts_with_closed_runtime_and_does_not_restore_circuits() {
        let registry = CircuitRegistry::default();
        let policy = policy();
        for _ in 0..2 {
            let permit = registry.acquire("codex", "provider-a", policy).unwrap();
            registry.record_failure(permit, policy);
        }
        assert_eq!(registry.snapshots()[0].status, "open");

        let restarted = CircuitRegistry::default();
        assert!(restarted.snapshots().is_empty());

        registry.reset("codex", "provider-a");
        assert_eq!(registry.snapshots()[0].status, "closed");
    }
}
