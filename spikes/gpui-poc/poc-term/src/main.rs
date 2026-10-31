//! Output-only renderer: callback intervals are not GPU presentation measurements.
mod model;
mod offline;
#[cfg(feature = "allocator-mimalloc")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

const ALLOCATOR_NAME: &str = if cfg!(feature = "allocator-mimalloc") {
    "mimalloc-0.1.52"
} else {
    "system"
};
use gpui::{prelude::*, *};
use model::{Model, COLS, ROWS};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Pane {
    model: Arc<Mutex<Model>>,
    cache: Vec<Option<ShapedLine>>,
    cell: f32,
    line: f32,
}
impl Render for Pane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dirty = self.model.lock().unwrap().damaged();
        let prepare = cx.entity();
        let paint = cx.entity();
        let cell = self.cell;
        let line_height = self.line;
        canvas(
            move |_, window, cx| {
                prepare.update(cx, |this, _| {
                    let mut style = window.text_style();
                    style.font_family = "Consolas".into();
                    for (y, text) in dirty {
                        let run = TextRun {
                            len: text.len(),
                            font: style.font(),
                            color: rgb(0xe8edf4).into(),
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        };
                        this.cache[y] = Some(window.text_system().shape_line(
                            text.into(),
                            px(cell / 0.6),
                            &[run],
                            None,
                        ));
                    }
                });
            },
            move |bounds, _, window, cx| {
                window.paint_quad(fill(bounds, rgb(0x18202b)));
                paint.update(cx, |this, cx| {
                    for (y, line) in this.cache.iter().enumerate() {
                        if let Some(line) = line {
                            let origin =
                                point(bounds.left(), bounds.top() + px(y as f32 * line_height));
                            let _ = line.paint(
                                origin,
                                px(line_height),
                                TextAlign::Left,
                                Some(bounds.size.width),
                                window,
                                cx,
                            );
                        }
                    }
                    let m = this.model.lock().unwrap();
                    let cursor = m.term.grid().cursor.point;
                    if m.term
                        .mode()
                        .contains(alacritty_terminal::term::TermMode::SHOW_CURSOR)
                    {
                        let origin = point(
                            bounds.left() + px(cursor.column.0 as f32 * cell),
                            bounds.top() + px(cursor.line.0 as f32 * line_height),
                        );
                        window.paint_quad(fill(
                            Bounds::new(origin, size(px(2.), px(line_height))),
                            rgb(0x60a5fa),
                        ));
                    }
                });
            },
        )
        .w(px(COLS as f32 * cell))
        .h(px(ROWS as f32 * line_height))
    }
}

struct TerminalProbe {
    panes: Vec<Entity<Pane>>,
    models: Vec<Arc<Mutex<Model>>>,
    start: Instant,
    previous: Instant,
    intervals: Vec<f64>,
    finished: bool,
    chinese: bool,
}
impl Render for TerminalProbe {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        self.intervals
            .push((now - self.previous).as_secs_f64() * 1000.);
        self.previous = now;
        let done = self.models.iter().all(|m| m.lock().unwrap().done);
        if !self.finished && (done || self.start.elapsed() > Duration::from_secs(130)) {
            self.finished = true;
            let samples: Vec<_> = self
                .models
                .iter()
                .map(|m| {
                    let m = m.lock().unwrap();
                    serde_json::json!({"bytes":m.bytes,"parse_ms":m.parse_ns as f64 / 1e6,
                    "receive_parse_ms":m.first.zip(m.last).map(|(a,b)| (b-a).as_secs_f64()*1000.),
                    "done":m.done,"error":m.error})
                })
                .collect();
            println!(
                "terminal_metrics={}",
                serde_json::json!({"panes":samples,
                "render_callback_intervals_ms":self.intervals,"presentation_verified":false,
                "scope":"output-only monochrome rows; no input/selection/SGR fidelity"})
            );
            cx.spawn(async |_, cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let _ = cx.update(|cx| {
                    println!("poc-term: smoke timer completed");
                    cx.quit();
                });
            })
            .detach();
        }
        if !self.finished {
            // Refresh each pane on the platform frame callback, retaining shaped unchanged rows.
            for pane in &self.panes {
                pane.update(cx, |_, cx| cx.notify());
            }
            window.request_animation_frame();
            let entity = cx.entity_id();
            window.on_next_frame(move |_, cx| cx.notify(entity));
        }
        let mut column = div()
            .flex()
            .flex_col()
            .gap_2()
            .bg(rgb(0x10161f))
            .text_color(rgb(0xe8edf4));
        column = column.child(if self.chinese {
            "终端绘制实验：单色输出；帧呈现与输入待验证"
        } else {
            "Terminal probe: monochrome output; presentation/input pending"
        });
        for chunk in self.panes.chunks(4) {
            let mut row = div().flex().gap_2();
            for pane in chunk {
                row = row.child(pane.clone());
            }
            column = column.child(row);
        }
        column
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if let Some(index) = args.iter().position(|a| a == "--parse-fixture") {
        return offline::parse(std::path::Path::new(
            args.get(index + 1).ok_or("missing fixture path")?,
        ));
    }
    if !args.iter().any(|a| a == "--smoke") {
        println!("poc-term: --smoke [--eight] [--fixture PATH] | --parse-fixture PATH");
        return Ok(());
    }
    let count = if args.iter().any(|a| a == "--eight") {
        8
    } else {
        1
    };
    let fixture = args
        .iter()
        .position(|a| a == "--fixture")
        .map(|i| args.get(i + 1).ok_or("missing fixture path"))
        .transpose()?;
    let command = if let Some(path) = fixture {
        let path = PathBuf::from(path).canonicalize()?;
        if !path.is_file() {
            return Err("fixture must be a file".into());
        }
        let path = path.to_str().ok_or("fixture path must be UTF-8")?;
        if path.contains(['\r', '\n', '"', '%']) {
            return Err("unsupported shell path character".into());
        }
        let path = path.replace('\'', "''");
        format!("& cmd /d /c 'type \"{path}\"'; Write-Output ('NATIVE_POC_' + 'DONE')\r")
    } else {
        "1..1000 | ForEach-Object { Write-Output ('native row ' + $_) }; Write-Output ('NATIVE_POC_' + 'DONE')\r".into()
    };
    let models: Vec<_> = (0..count)
        .map(|_| Arc::new(Mutex::new(Model::new())))
        .collect();
    let mut start_signals = Vec::new();
    let mut workers = Vec::new();
    for model in &models {
        let model = model.clone();
        let command = command.clone();
        let (start_tx, start_rx) = std::sync::mpsc::channel();
        start_signals.push(start_tx);
        workers.push(std::thread::spawn(move || {
            if start_rx.recv_timeout(Duration::from_secs(10)).is_err() {
                let mut m = model.lock().unwrap();
                m.done = true;
                m.error = true;
                return;
            }
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let result = runtime.block_on(poc_daemon::probe(Some(&command), |frame| {
                if frame.kind == 5 {
                    model.lock().unwrap().reset();
                }
                for bytes in frame.data.as_bytes().chunks(4096) {
                    model.lock().unwrap().advance(bytes);
                }
            }));
            let mut m = model.lock().unwrap();
            m.done = true;
            m.error = result.is_err();
            if let Err(error) = result {
                eprintln!("temporary terminal session failed: {error}");
            }
        }));
    }
    let final_models = models.clone();
    gpui_platform::application().run(move |cx: &mut App| {
        let cell = if count == 8 { 5.2 } else { 10. };
        let line = if count == 8 { 16. } else { 20. };
        let bounds = Bounds::centered(
            None,
            size(
                px(if count == 8 { 1720. } else { 850. }),
                px(if count == 8 { 850. } else { 540. }),
            ),
            cx,
        );
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |window, cx| {
                window.on_next_frame(move |_, _| {
                    for signal in start_signals {
                        let _ = signal.send(());
                    }
                });
                let panes = models
                    .iter()
                    .map(|model| {
                        cx.new(|_| Pane {
                            model: model.clone(),
                            cache: vec![None; ROWS],
                            cell,
                            line,
                        })
                    })
                    .collect();
                cx.new(|_| TerminalProbe {
                    panes,
                    models,
                    start: Instant::now(),
                    previous: Instant::now(),
                    intervals: Vec::new(),
                    finished: false,
                    chinese: std::env::var("POC_LANG").as_deref() != Ok("en-US"),
                })
            },
        )
        .expect("open terminal probe");
        cx.activate(true);
        // Closing early does not quit workers mid-cleanup. The watchdog lets their 120s timeout run.
        cx.spawn(async |cx| {
            cx.background_executor()
                .timer(Duration::from_secs(140))
                .await;
            let _ = cx.update(|cx| cx.quit());
        })
        .detach();
    });
    for worker in workers {
        worker.join().map_err(|_| "terminal worker panicked")?;
    }
    if final_models.iter().any(|m| {
        let m = m.lock().unwrap();
        !m.done || m.error
    }) {
        return Err("terminal experiment incomplete or failed".into());
    }
    Ok(())
}
