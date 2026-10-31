use gpui::{App, Font, Global, Pixels, Window};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    time::Instant,
};

const MAX_METRIC_ENTRIES: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct MetricKey {
    font: Font,
    size_bits: u32,
}

#[derive(Default)]
struct MetricEntries {
    values: HashMap<MetricKey, (f32, f32)>,
    insertion_order: VecDeque<MetricKey>,
}

impl MetricEntries {
    fn get_or_measure(
        &mut self,
        key: MetricKey,
        measure: impl FnOnce() -> (f32, f32),
    ) -> (f32, f32) {
        if let Some(metrics) = self.values.get(&key) {
            return *metrics;
        }
        let metrics = measure();
        if self.values.len() == MAX_METRIC_ENTRIES {
            if let Some(oldest) = self.insertion_order.pop_front() {
                self.values.remove(&oldest);
            }
        }
        self.insertion_order.push_back(key.clone());
        self.values.insert(key, metrics);
        metrics
    }
}

#[derive(Default)]
struct FontMetricsCache(RefCell<MetricEntries>);

impl Global for FontMetricsCache {}

pub(crate) fn cell_metrics(
    descriptor: Font,
    size: Pixels,
    window: &Window,
    cx: &mut App,
) -> (f32, f32) {
    if cx.try_global::<FontMetricsCache>().is_none() {
        cx.set_global(FontMetricsCache::default());
    }
    let key = MetricKey {
        font: descriptor.clone(),
        size_bits: size.as_f32().to_bits(),
    };
    cx.global::<FontMetricsCache>()
        .0
        .borrow_mut()
        .get_or_measure(key, || {
            let started = Instant::now();
            let text_system = window.text_system();
            let font_id = text_system.resolve_font(&descriptor);
            let width = text_system
                .ch_advance(font_id, size)
                .map(|advance| advance.as_f32())
                .unwrap_or(8.0)
                .max(1.0);
            let height = (text_system.ascent(font_id, size) + text_system.descent(font_id, size))
                .as_f32()
                .max(1.0);
            eprintln!(
                "[gpui-fonts] phase=measure-cell family={} size={} duration_us={}",
                descriptor.family,
                size.as_f32(),
                started.elapsed().as_micros()
            );
            (width, height)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(family: &str, size: f32) -> MetricKey {
        MetricKey {
            font: gpui::font(family.to_owned()),
            size_bits: size.to_bits(),
        }
    }

    #[test]
    fn repeated_panes_reuse_measurement_and_initialization_is_lazy() {
        let mut entries = MetricEntries::default();
        let calls = std::cell::Cell::new(0);
        assert!(entries.values.is_empty());
        assert_eq!(calls.get(), 0);
        for _pane in 0..8 {
            assert_eq!(
                entries.get_or_measure(key("Consolas", 16.0), || {
                    calls.set(calls.get() + 1);
                    (8.0, 16.0)
                }),
                (8.0, 16.0)
            );
        }
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn font_descriptor_and_size_select_independent_metrics() {
        let mut entries = MetricEntries::default();
        entries.get_or_measure(key("Consolas", 16.0), || (8.0, 16.0));
        assert_eq!(
            entries.get_or_measure(key("Consolas", 20.0), || (10.0, 20.0)),
            (10.0, 20.0)
        );
        assert_eq!(
            entries.get_or_measure(key("Cascadia Code", 16.0), || (9.0, 18.0)),
            (9.0, 18.0)
        );
        let mut bold = key("Consolas", 16.0);
        bold.font.weight = gpui::FontWeight::BOLD;
        assert_eq!(entries.get_or_measure(bold, || (9.0, 16.0)), (9.0, 16.0));
        assert_eq!(
            entries.get_or_measure(key("Consolas", 16.0), || panic!("cache miss")),
            (8.0, 16.0)
        );
    }

    #[test]
    fn capacity_evicts_old_entries_without_losing_new_metrics() {
        let mut entries = MetricEntries::default();
        for size in 1..=MAX_METRIC_ENTRIES + 1 {
            entries.get_or_measure(key("Consolas", size as f32), || (size as f32, 16.0));
        }
        assert_eq!(entries.values.len(), MAX_METRIC_ENTRIES);
        assert_eq!(entries.insertion_order.len(), MAX_METRIC_ENTRIES);
        assert!(!entries.values.contains_key(&key("Consolas", 1.0)));
        assert_eq!(
            entries.get_or_measure(key("Consolas", 2.0), || panic!("cache miss")),
            (2.0, 16.0)
        );
    }
}
