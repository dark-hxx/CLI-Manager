//! Interactive component probe; window smoke is not system IME acceptance.
mod composition;
mod exercise;
mod ime_receiver;
use gpui::{
    div, prelude::*, px, size, App, Bounds, Context, Entity, Window, WindowBounds, WindowOptions,
};
use gpui_component::{
    input::{Editor, EditorState, Input, InputState},
    Root,
};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

struct InputProbe {
    input: Entity<InputState>,
    editor: Entity<EditorState>,
    receiver: Entity<ime_receiver::ImeReceiver>,
    chinese: bool,
}

impl Render for InputProbe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let (title, input_label, editor_label) = if self.chinese {
            (
                "输入与编辑器实验：系统输入法待人工验证",
                "单行输入",
                "代码编辑器",
            )
        } else {
            (
                "Input/editor probe: system IME needs manual validation",
                "Single line input",
                "Code editor",
            )
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .p_4()
            .gap_3()
            .child(title)
            .child(input_label)
            .child(Input::new(&self.input))
            .child(if self.chinese {
                "自绘 IME 接收器（点击输入）"
            } else {
                "Canvas IME receiver (click to type)"
            })
            .child(self.receiver.clone())
            .child(editor_label)
            .child(Editor::new(&self.editor).h(px(420.)))
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let smoke = args.iter().any(|arg| arg == "--smoke");
    let exercise = args.iter().any(|arg| arg == "--exercise");
    let passed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let final_passed = passed.clone();
    if !smoke && !args.iter().any(|arg| arg == "--window") {
        println!("poc-input: --window|--smoke [--fixture PATH] [--exercise]; POC_LANG=zh-CN|en-US");
        return Ok(());
    }
    let chinese = std::env::var("POC_LANG").as_deref() != Ok("en-US");
    let fixture = args
        .iter()
        .position(|arg| arg == "--fixture")
        .map(|i| {
            args.get(i + 1)
                .map(PathBuf::from)
                .ok_or("missing fixture path")
        })
        .transpose()?;
    let started = Instant::now();
    let language = match fixture
        .as_ref()
        .and_then(|p| p.extension())
        .and_then(|s| s.to_str())
    {
        Some("ts") => "typescript",
        Some("log") => "plaintext",
        _ => "rust",
    };
    let text = if let Some(path) = fixture {
        std::fs::read_to_string(path)?
    } else {
        "// 中文、组合字符 e\u{301}、emoji 🙂\nfn main() { println!(\"Hello\"); }\n".into()
    };
    println!(
        "fixture: bytes={} read_ms={:.3}",
        text.len(),
        started.elapsed().as_secs_f64() * 1000.
    );
    gpui_platform::application().run(move |cx: &mut App| {
        gpui_component::init(cx);
        let bounds = Bounds::centered(None, size(px(900.), px(640.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |window, cx| {
                let started = Instant::now();
                let input = cx.new(|cx| InputState::new(window, cx));
                let receiver = cx.new(|cx| ime_receiver::ImeReceiver::new(window, cx));
                let editor = cx.new(|cx| {
                    EditorState::new(window, cx)
                        .language(language)
                        .default_value(text)
                });
                println!(
                    "editor: construct_ms={:.3}; first-frame/editing not timed",
                    started.elapsed().as_secs_f64() * 1000.
                );
                if exercise {
                    exercise::schedule(editor.clone(), window, cx, passed);
                }
                let view = cx.new(|_| InputProbe {
                    input,
                    editor,
                    receiver,
                    chinese,
                });
                cx.new(|cx| Root::new(view, window, cx))
            },
        )
        .expect("open isolated input probe");
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
        if smoke {
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_secs(5)).await;
                let _ = cx.update(|cx| {
                    println!("poc-input: smoke timer completed");
                    cx.quit();
                });
            })
            .detach();
        }
    });
    if exercise && !final_passed.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("editor search/replace/undo/redo exercise did not pass".into());
    }
    Ok(())
}
