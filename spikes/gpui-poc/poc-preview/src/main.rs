//! Offline embedded WebView probe. No product settings or WebView profile reused.
mod capture;
use gpui::{prelude::*, *};
use std::{
    borrow::Cow,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

struct Preview {
    view: Option<wry::WebView>,
    context: Option<wry::WebContext>,
    profile: PathBuf,
    pdf: Arc<Vec<u8>>,
    loaded: Arc<Mutex<Vec<String>>>,
    start: Instant,
    phase: usize,
    smoke: bool,
    chinese: bool,
    child_bounds: Option<(f64, f64)>,
    captured: [bool; 3],
    captures: capture::Captures,
}
fn rect(width: f64, height: f64) -> wry::Rect {
    wry::Rect {
        position: wry::dpi::LogicalPosition::new(12., 64.).into(),
        size: wry::dpi::LogicalSize::new(width.max(1.), height.max(1.)).into(),
    }
}
fn route_url(path: &str) -> String {
    // Wry rewrites the initial custom URL on Windows, but load_url calls Navigate directly.
    if cfg!(target_os = "windows") {
        format!("http://climgr-preview.localhost/{path}")
    } else {
        format!("climgr-preview://localhost/{path}")
    }
}
impl Render for Preview {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let width = f64::from(f32::from(viewport.width)) - 24.;
        let height = f64::from(f32::from(viewport.height)) - 80.;
        let routes = ["markdown", "html", "sample.pdf"];
        if self.view.is_none() && self.phase == 0 {
            let mut context = wry::WebContext::new(Some(self.profile.clone()));
            let pdf = self.pdf.clone();
            let chinese = self.chinese;
            let loaded = self.loaded.clone();
            let start = Instant::now();
            let view = wry::WebViewBuilder::new_with_web_context(&mut context)
                .with_custom_protocol("climgr-preview".into(), move |_, request| {
                    let path = request.uri().path();
                    let (status, mime, body): (_, _, Vec<u8>) = match path {
                        "/markdown" => (200, "text/html; charset=utf-8", format!("<!doctype html><meta charset=utf-8><h1>{}</h1><p>Markdown → HTML</p><pre>native preview fixture</pre>", if chinese {"Markdown 预览实验"} else {"Markdown preview probe"}).into_bytes()),
                        "/html" => (200, "text/html; charset=utf-8", format!("<!doctype html><meta charset=utf-8><h1>{}</h1><input aria-label='fixture' value='中文 / English 🙂'><p>Offline HTML fixture</p>", if chinese {"本地 HTML 预览"} else {"Local HTML preview"}).into_bytes()),
                        "/sample.pdf" => (200, "application/pdf", pdf.as_ref().clone()),
                        _ => (404, "text/plain", b"Unknown fixture".to_vec()),
                    };
                    wry::http::Response::builder().status(status).header("Content-Type", mime)
                        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
                        .body(Cow::Owned(body)).unwrap()
                })
                .with_navigation_handler(|url| url.starts_with("http://climgr-preview.localhost/") || url.starts_with("climgr-preview://localhost/"))
                .with_on_page_load_handler(move |event, url| {
                    if matches!(event, wry::PageLoadEvent::Finished) {
                        loaded.lock().unwrap().push(url);
                    }
                })
                .with_bounds(rect(width, height))
                .with_url("climgr-preview://localhost/markdown")
                .build_as_child(window);
            match view {
                Ok(view) => {
                    self.view = Some(view);
                    self.context = Some(context);
                    self.phase = 1;
                    println!(
                        "webview_create_ms={:.3}",
                        start.elapsed().as_secs_f64() * 1000.
                    );
                }
                Err(_) => {
                    eprintln!("embedded WebView creation failed");
                    self.phase = 99;
                    cx.quit();
                }
            }
        }
        if let Some(view) = &self.view {
            if self.child_bounds != Some((width, height)) {
                if view.set_bounds(rect(width, height)).is_ok() {
                    println!("webview_bounds_logical={width}x{height}; actual={:?}", view.bounds());
                    self.child_bounds = Some((width, height));
                }
            }
            if self.smoke {
                let elapsed = self.start.elapsed().as_secs_f64();
                for (index, path) in routes.iter().enumerate() {
                    if self.phase == index + 1 && !self.captured[index]
                        && elapsed > [2., 5., 9.][index]
                        && self.loaded.lock().unwrap().iter().any(|url| url.ends_with(path)) {
                        self.captured[index] = true;
                        let target = self.profile.parent().unwrap().join(format!(
                            "preview-{}-{}-{}.png", std::process::id(),
                            if self.chinese {"zh-CN"} else {"en-US"}, path.replace('.', "-")));
                        if let Err(error) = capture::capture(view, target, self.captures.clone()) {
                            eprintln!("WebView surface capture failed: {error}");
                            self.captures.lock().unwrap().push(Err(error.to_string()));
                        }
                    }
                }
                if self.phase == 1 && elapsed > 3. {
                    if view
                        .set_visible(false)
                        .and_then(|_| view.load_url(&route_url("html")))
                        .and_then(|_| view.set_visible(true))
                        .is_err()
                    {
                        eprintln!("WebView hide/navigation/show failed");
                        cx.quit();
                    }
                    self.phase = 2;
                }
                if self.phase == 2 && elapsed > 6. {
                    if view.load_url(&route_url("sample.pdf")).is_err() {
                        eprintln!("PDF navigation failed");
                        cx.quit();
                    }
                    self.phase = 3;
                }
                if elapsed > 11. {
                    self.view.take();
                    println!("finished_load_routes={:?}; PDF pixels/focus/DPI/airspace require inspection", self.loaded.lock().unwrap());
                    println!("poc-preview: smoke timer completed");
                    cx.quit();
                }
                window.request_animation_frame();
                let entity = cx.entity_id();
                window.on_next_frame(move |_, cx| cx.notify(entity));
            }
        }
        let mut root = div()
            .size_full()
            .bg(rgb(0x18202b))
            .text_color(rgb(0xe8edf4))
            .p_2();
        root = root.child(if self.chinese {
            "离线 WebView 实验：加载事件不代表 PDF 画面验收通过"
        } else {
            "Offline WebView: load events do not prove PDF rendering"
        });
        root.child(format!("{} / {}", self.phase, routes.len()))
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|a| a == "--probe") {
        println!("webview_version={}", wry::webview_version()?);
        return Ok(());
    }
    let smoke = std::env::args().any(|a| a == "--smoke");
    if !smoke && !std::env::args().any(|a| a == "--window") {
        println!("poc-preview: --probe|--smoke|--window");
        return Ok(());
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bench/results");
    let pdf = Arc::new(std::fs::read(root.join("preview-fixtures/sample.pdf"))?);
    let profile = root.join(format!("webview-profile-{}", std::process::id()));
    let status = Arc::new(Mutex::new(Vec::new()));
    let final_status = status.clone();
    let captures = capture::Captures::default();
    let final_captures = captures.clone();
    gpui_platform::application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(900.), px(700.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |_, cx| {
                cx.new(|_| Preview {
                    view: None,
                    context: None,
                    profile,
                    pdf,
                    loaded: status,
                    start: Instant::now(),
                    phase: 0,
                    smoke,
                    chinese: std::env::var("POC_LANG").as_deref() != Ok("en-US"),
                    child_bounds: None,
                    captured: [false; 3],
                    captures,
                })
            },
        )
        .expect("open preview probe");
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
    });
    if smoke
        && !["/markdown", "/html", "/sample.pdf"]
            .iter()
            .all(|expected| {
                final_status
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|url| url.ends_with(expected))
            })
    {
        return Err("not all three fixture navigation events finished".into());
    }
    if smoke && cfg!(target_os = "windows") {
        let captures = final_captures.lock().unwrap();
        if captures.len() != 3 || captures.iter().any(Result::is_err) {
            return Err("not all three WebView surface captures completed".into());
        }
    }
    Ok(())
}
