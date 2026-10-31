//! Dependency compatibility plus an opt-in platform/window smoke, not a benchmark.
use alacritty_terminal as _;
use gpui::{
    div, prelude::*, px, rgb, size, App, Bounds, Context, Window, WindowBounds, WindowOptions,
};
use gpui_component as _;
use std::time::Duration;
use tokio_tungstenite as _;
use wry as _;

struct CompatibilityWindow;

impl Render for CompatibilityWindow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let chinese = std::env::var("POC_LANG").as_deref() != Ok("en-US");
        let text = if chinese {
            "GPUI 平台窗口验证（不代表 IME 或性能通过）"
        } else {
            "GPUI window smoke; IME/performance pending"
        };
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgb(0x18202b))
            .text_color(rgb(0xe8edf4))
            .child(text)
    }
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let smoke = args.iter().any(|arg| arg == "--smoke");
    if !smoke && !args.iter().any(|arg| arg == "--window") {
        println!("poc-compat: --window or --smoke; POC_LANG=zh-CN|en-US");
        return;
    }
    gpui_platform::application().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(640.), px(240.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_, cx| cx.new(|_| CompatibilityWindow),
        )
        .expect("open isolated GPUI compatibility window");
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
        println!("poc-compat: window opened");
        if smoke {
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_secs(5)).await;
                let _ = cx.update(|cx| {
                    println!("poc-compat: smoke timer completed");
                    cx.quit();
                });
            })
            .detach();
        }
    });
}
