use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::Duration,
};

const MAX_TRACKED_LAYOUTS: usize = 4096;

pub(super) struct LayoutTracker<Layout> {
    known: HashMap<usize, Weak<Layout>>,
}

impl<Layout> Default for LayoutTracker<Layout> {
    fn default() -> Self {
        Self {
            known: HashMap::new(),
        }
    }
}

impl<Layout> LayoutTracker<Layout> {
    pub(super) fn observe(&mut self, layout: &Arc<Layout>) -> (bool, bool) {
        let address = Arc::as_ptr(layout) as usize;
        let reused = self
            .known
            .get(&address)
            .and_then(Weak::upgrade)
            .is_some_and(|previous| Arc::ptr_eq(&previous, layout));
        let mut evicted = false;
        if !reused && self.known.len() >= MAX_TRACKED_LAYOUTS {
            self.known.retain(|_, layout| layout.strong_count() > 0);
            if self.known.len() >= MAX_TRACKED_LAYOUTS {
                self.known.clear();
                evicted = true;
            }
        }
        self.known.insert(address, Arc::downgrade(layout));
        (reused, evicted)
    }
}

#[derive(Default, Serialize)]
pub(super) struct Distribution {
    samples: usize,
    p50_us: u64,
    p95_us: u64,
    max_us: u64,
}

impl Distribution {
    pub(super) fn from_durations(values: &[Duration]) -> Self {
        let mut values: Vec<_> = values
            .iter()
            .map(|value| value.as_micros().min(u64::MAX as u128) as u64)
            .collect();
        values.sort_unstable();
        let percentile = |percent: usize| {
            values
                .get((values.len() * percent).div_ceil(100).saturating_sub(1))
                .copied()
                .unwrap_or(0)
        };
        Self {
            samples: values.len(),
            p50_us: percentile(50),
            p95_us: percentile(95),
            max_us: values.last().copied().unwrap_or(0),
        }
    }
}

#[derive(Default)]
pub(super) struct CacheMetrics {
    layouts: LayoutTracker<gpui::LineLayout>,
    pub(super) measuring: bool,
    pub(super) observed: usize,
    pub(super) reused: usize,
    pub(super) tracking_evictions: usize,
    pub(super) errors: usize,
    pub(super) intervals: Vec<Duration>,
    pub(super) preparation: Vec<Duration>,
    pub(super) shaping: Vec<Duration>,
    pub(super) painting: Vec<Duration>,
}

impl CacheMetrics {
    pub(super) fn observe(&mut self, layout: &Arc<gpui::LineLayout>) {
        let (reused, evicted) = self.layouts.observe(layout);
        if self.measuring {
            self.observed += 1;
            self.reused += usize::from(reused);
            self.tracking_evictions += usize::from(evicted);
        }
    }

    pub(super) fn report(&self, panes: usize, workload: &str, frames: usize) -> serde_json::Value {
        serde_json::json!({
            "schema_version": 1, "scope": "synthetic_native_terminal_cache",
            "panes": panes, "workload": workload, "frames": frames,
            "layout_observations": self.observed, "layout_object_reuses": self.reused,
            "observed_reuse_ratio": if self.observed == 0 { 0. } else {
                self.reused as f64 / self.observed as f64
            },
            "tracking_evictions": self.tracking_evictions, "errors": self.errors,
            "frame_callback_intervals": Distribution::from_durations(&self.intervals),
            "frame_preparation_cpu": Distribution::from_durations(&self.preparation),
            "shape_text_call_cpu": Distribution::from_durations(&self.shaping),
            "line_paint_call_cpu": Distribution::from_durations(&self.painting),
            "presentation_verified": false, "live_pty": false,
            "glyph_atlas_hit_rate_measured": false
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_shared_objects_not_equal_values_and_never_keeps_layouts_alive() {
        let mut tracker = LayoutTracker::default();
        let original = Arc::new(7);
        let equal_but_distinct = Arc::new(7);
        assert_eq!(tracker.observe(&original), (false, false));
        assert_eq!(tracker.observe(&original.clone()), (true, false));
        assert_eq!(tracker.observe(&equal_but_distinct), (false, false));
        assert_eq!(Arc::strong_count(&original), 1);
        let weak = Arc::downgrade(&original);
        drop(original);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn layout_tracking_is_bounded_even_when_all_layouts_are_live() {
        let mut tracker = LayoutTracker::default();
        let layouts: Vec<_> = (0..MAX_TRACKED_LAYOUTS + 1).map(Arc::new).collect();
        for layout in &layouts[..MAX_TRACKED_LAYOUTS] {
            assert_eq!(tracker.observe(layout), (false, false));
        }
        assert_eq!(tracker.observe(layouts.last().unwrap()), (false, true));
        assert_eq!(tracker.known.len(), 1);
    }

    #[test]
    fn percentile_reports_empty_single_and_nearest_rank_samples() {
        assert_eq!(Distribution::from_durations(&[]).samples, 0);
        let singleton = Distribution::from_durations(&[Duration::from_micros(42)]);
        assert_eq!(
            (singleton.p50_us, singleton.p95_us, singleton.max_us),
            (42, 42, 42)
        );
        let samples: Vec<_> = (1..=100).rev().map(Duration::from_micros).collect();
        let distribution = Distribution::from_durations(&samples);
        assert_eq!(
            (
                distribution.p50_us,
                distribution.p95_us,
                distribution.max_us
            ),
            (50, 95, 100)
        );
    }
}
