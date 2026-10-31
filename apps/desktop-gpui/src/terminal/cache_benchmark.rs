use super::{
    cache_metrics::CacheMetrics,
    render::{prepared_lines, PreparedLine},
};
use cli_manager_core_prefs::terminal::TerminalPreferences;
use cli_manager_term_engine::{Cell, Engine, EventProxy, Size};
use gpui::{
    canvas, div, point, prelude::*, px, relative, rgb, size, App, Bounds, Context, Div, Render,
    TextAlign, Window, WindowBounds, WindowOptions,
};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const WARMUP_FRAMES: usize = 8;
const SAMPLE_FRAMES: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Workload {
    Shared,
    Unique,
    Scroll,
    Appearance,
}

impl Workload {
    fn name(self) -> &'static str {
        match self {
            Self::Shared => "shared_static",
            Self::Unique => "unique_static",
            Self::Scroll => "scrolling",
            Self::Appearance => "appearance_changes",
        }
    }
}

struct Pane {
    engine: Engine,
    rows: Vec<Vec<Cell>>,
}

impl Pane {
    fn new(index: usize, workload: Workload) -> Self {
        let mut engine =
            Engine::new(Size::new(40, 12).unwrap(), 1000, EventProxy::new(|_| {})).unwrap();
        engine.advance(b"\x1b[?25l");
        for row in 0..80 {
            let identity = if workload == Workload::Shared {
                0
            } else {
                index
            };
            let text = format!(
                "\x1b[32m{identity}:{row:04}\x1b[0m \x1b[1;3mcache\x1b[0m 中文 e\u{301}\r\n"
            );
            engine.advance(text.as_bytes());
        }
        Self {
            engine,
            rows: vec![Vec::new(); 12],
        }
    }

    fn prepare(
        &mut self,
        index: usize,
        tick: usize,
        workload: Workload,
        settings: &TerminalPreferences,
        cell: (f32, f32),
        cache: Option<&mut super::row_cache::RowPreparationCache>,
    ) -> Vec<PreparedLine> {
        self.engine
            .configure(
                settings.effective_scrollback(),
                super::appearance::cursor_shape(settings),
            )
            .unwrap();
        if workload == Workload::Scroll {
            self.engine
                .advance(format!("{index}:{tick:04} scrolling 中文\r\n").as_bytes());
        }
        let frame = self.engine.snapshot();
        for (row, cells) in &frame.rows {
            self.rows[*row] = cells.clone();
        }
        let urls = cli_manager_term_engine::search::find_urls(&self.rows);
        let query = if workload == Workload::Appearance && tick % 16 < 8 {
            "cache"
        } else {
            ""
        };
        let matches = cli_manager_term_engine::search::find_matches(&self.rows, query);
        let selection =
            (workload == Workload::Appearance && tick % 12 < 6).then_some(((0, 1), (2, 8)));
        prepared_lines(
            &self.rows, &frame, selection, &urls, &matches, settings, cell, cache,
        )
    }
}

struct Benchmark {
    row_cache: super::row_cache::RowPreparationCache,
    use_row_cache: bool,
    cases: Vec<(usize, Workload)>,
    case: usize,
    frame: usize,
    last_frame: Option<Instant>,
    panes: Vec<Pane>,
    metrics: Rc<RefCell<CacheMetrics>>,
    completed: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
}

impl Benchmark {
    fn new(completed: Arc<AtomicBool>, failed: Arc<AtomicBool>) -> Self {
        let mut cases: Vec<_> = [1, 2, 4, 8]
            .into_iter()
            .flat_map(|count| {
                [Workload::Shared, Workload::Unique, Workload::Scroll]
                    .map(|workload| (count, workload))
            })
            .collect();
        cases.push((8, Workload::Appearance));
        Self {
            row_cache: super::row_cache::RowPreparationCache::default(),
            use_row_cache: !std::env::args().any(|arg| arg == "--terminal-cache-uncached"),
            cases,
            case: 0,
            frame: 0,
            last_frame: None,
            panes: vec![Pane::new(0, Workload::Shared)],
            metrics: Rc::new(RefCell::new(CacheMetrics::default())),
            completed,
            failed,
        }
    }

    fn finish_case(&mut self) {
        let (panes, workload) = self.cases[self.case];
        let metrics = self.metrics.borrow();
        println!(
            "[gpui-terminal-cache] {}",
            metrics.report(panes, workload.name(), SAMPLE_FRAMES)
        );
        let stats = self.row_cache.stats();
        println!(
            "[gpui-terminal-row-cache] {}",
            serde_json::json!({
                "panes": panes, "workload": workload.name(), "enabled": self.use_row_cache,
                "hits": stats.hits, "misses": stats.misses, "evictions": stats.evictions,
                "bypasses": stats.bypasses, "entries": stats.entries,
                "estimated_retained_bytes": stats.retained_bytes
            })
        );
        if metrics.errors > 0
            || metrics.observed == 0
            || metrics.reused == 0
            || metrics.preparation.len() != SAMPLE_FRAMES
            || metrics.intervals.len() != SAMPLE_FRAMES - 1
        {
            self.failed.store(true, Ordering::Release);
        }
    }

    fn next_case(&mut self) {
        self.row_cache = super::row_cache::RowPreparationCache::default();
        self.case += 1;
        self.frame = 0;
        self.last_frame = None;
        self.metrics = Rc::new(RefCell::new(CacheMetrics::default()));
        if let Some(&(count, workload)) = self.cases.get(self.case) {
            self.panes = (0..count).map(|index| Pane::new(index, workload)).collect();
        }
    }
}

fn line_canvas(
    line: PreparedLine,
    font_size: f32,
    line_height: f32,
    metrics: Rc<RefCell<CacheMetrics>>,
) -> impl IntoElement {
    let paint_metrics = metrics.clone();
    canvas(
        move |bounds, window, _| {
            let started = Instant::now();
            let result = window.text_system().shape_text(
                line.text,
                px(font_size),
                &line.runs,
                Some(bounds.size.width),
                None,
            );
            let mut metrics = metrics.borrow_mut();
            if metrics.measuring {
                metrics.shaping.push(started.elapsed());
            }
            match result {
                Ok(lines) => {
                    for line in &lines {
                        metrics.observe(&line.unwrapped_layout);
                    }
                    Some(lines)
                }
                Err(error) => {
                    eprintln!("GPUI terminal cache shape: {error}");
                    metrics.errors += 1;
                    None
                }
            }
        },
        move |bounds, lines, window, cx| {
            let started = Instant::now();
            let mut errors = 0;
            let mut offset = px(0.);
            if let Some(lines) = lines {
                for line in &lines {
                    if let Err(error) = line.paint(
                        bounds.origin + point(px(0.), offset),
                        px(line_height),
                        TextAlign::Left,
                        Some(bounds),
                        window,
                        cx,
                    ) {
                        eprintln!("GPUI terminal cache paint: {error}");
                        errors += 1;
                    }
                    offset += line.size(px(line_height)).height;
                }
            }
            let mut metrics = paint_metrics.borrow_mut();
            metrics.errors += errors;
            if metrics.measuring {
                metrics.painting.push(started.elapsed());
            }
        },
    )
    .w_full()
    .h(px(line_height))
}

impl Render for Benchmark {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.frame == WARMUP_FRAMES + SAMPLE_FRAMES {
            self.finish_case();
            self.next_case();
        }
        if self.case == self.cases.len() {
            self.completed.store(true, Ordering::Release);
            cx.quit();
            return div();
        }
        let started = Instant::now();
        if self.frame == WARMUP_FRAMES {
            self.metrics.borrow_mut().measuring = true;
            self.last_frame = None;
        }
        if self.metrics.borrow().measuring {
            if let Some(previous) = self.last_frame {
                self.metrics.borrow_mut().intervals.push(started - previous);
            }
        }
        self.last_frame = Some(started);
        let (count, workload) = self.cases[self.case];
        let mut settings = TerminalPreferences::default();
        if workload == Workload::Appearance {
            settings.font_size = if self.frame % 20 < 10 { 14. } else { 18. };
            settings.line_height = if self.frame % 16 < 8 { 1. } else { 1.4 };
        }
        let descriptor = super::appearance::font_descriptor(&settings);
        let (width, natural_height) =
            super::fonts::cell_metrics(descriptor, px(settings.font_size as f32), window, cx);
        let height = natural_height * settings.line_height as f32;
        let columns = match count {
            1 => 1,
            2 | 4 => 2,
            _ => 4,
        };
        let mut root: Div = div()
            .size_full()
            .flex()
            .flex_wrap()
            .items_start()
            .overflow_hidden()
            .bg(rgb(0x10161f));
        for (index, pane) in self.panes.iter_mut().enumerate() {
            let lines = pane.prepare(
                index,
                self.frame,
                workload,
                &settings,
                (width, height),
                self.use_row_cache.then_some(&mut self.row_cache),
            );
            let children = lines.into_iter().map(|line| {
                line_canvas(
                    line,
                    settings.font_size as f32,
                    height,
                    self.metrics.clone(),
                )
            });
            root = root.child(
                div()
                    .flex()
                    .flex_col()
                    .overflow_hidden()
                    .w(relative(1. / columns as f32))
                    .h(relative(if count <= 2 { 1. } else { 0.5 }))
                    .children(children),
            );
        }
        if self.metrics.borrow().measuring {
            self.metrics
                .borrow_mut()
                .preparation
                .push(started.elapsed());
        }
        self.frame += 1;
        window.request_animation_frame();
        let entity = cx.entity_id();
        window.on_next_frame(move |_, cx| cx.notify(entity));
        root
    }
}

pub(crate) fn run() -> Result<(), String> {
    let completed = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let completed_writer = completed.clone();
    let failed_writer = failed.clone();
    gpui_platform::application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
        let result = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |_, cx| cx.new(|_| Benchmark::new(completed_writer, failed_writer)),
        );
        if let Err(error) = result {
            eprintln!("GPUI terminal cache window: {error}");
            cx.quit();
            return;
        }
        cx.activate(true);
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_secs(90))
                .await;
            let _ = cx.update(|cx| cx.quit());
        })
        .detach();
    });
    if !completed.load(Ordering::Acquire) {
        Err("benchmark incomplete: window closed, rendering stalled, or watchdog expired".into())
    } else if failed.load(Ordering::Acquire) {
        Err(
            "benchmark reported shaping/paint errors, missing samples, or no observed layout reuse"
                .into(),
        )
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_and_unique_fixtures_reach_production_line_preparation() {
        let settings = TerminalPreferences::default();
        let mut first = Pane::new(0, Workload::Shared);
        let mut shared = Pane::new(7, Workload::Shared);
        let mut unique = Pane::new(7, Workload::Unique);
        let first = first.prepare(0, 0, Workload::Shared, &settings, (8., 16.), None);
        let shared = shared.prepare(7, 0, Workload::Shared, &settings, (8., 16.), None);
        let unique = unique.prepare(7, 0, Workload::Unique, &settings, (8., 16.), None);
        assert_eq!(first.len(), 12);
        assert_eq!(first[0].text, shared[0].text);
        assert_ne!(first[0].text, unique[0].text);
        for line in first {
            assert_eq!(
                line.runs.iter().map(|run| run.len).sum::<usize>(),
                line.text.len()
            );
            assert!(line.cursor.is_none());
        }
    }

    #[test]
    fn scrolling_changes_output_and_appearance_preserves_utf8_run_coverage() {
        let mut pane = Pane::new(0, Workload::Scroll);
        let settings = TerminalPreferences::default();
        let first = pane.prepare(0, 0, Workload::Scroll, &settings, (8., 16.), None);
        let next = pane.prepare(0, 1, Workload::Scroll, &settings, (8., 16.), None);
        assert_ne!(first[10].text, next[10].text);
        let mut pane = Pane::new(0, Workload::Appearance);
        for line in pane.prepare(0, 0, Workload::Appearance, &settings, (8., 16.), None) {
            let mut offset = 0;
            for run in line.runs {
                offset += run.len;
                assert!(line.text.is_char_boundary(offset));
            }
            assert_eq!(offset, line.text.len());
        }
    }
}
