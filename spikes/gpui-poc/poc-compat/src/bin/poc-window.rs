//! Windows-only isolated window experiment; no product namespace is accepted.
#[cfg(windows)]
#[path = "../window_probe/native.rs"]
mod native;
#[path = "../window_probe/protocol.rs"]
mod protocol;

#[cfg(windows)]
mod probe {
    use super::native;
    use gpui::{
        div, prelude::*, px, rgb, rgba, size, App, Bounds, Context, TitlebarOptions, Window,
        WindowBackgroundAppearance, WindowBounds, WindowControlArea, WindowOptions,
    };
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::{cell::RefCell, rc::Rc, sync::mpsc, time::Duration};

    struct Probe {
        chinese: bool,
        pet: bool,
    }
    fn hwnd(window: &Window) -> usize {
        match HasWindowHandle::window_handle(window)
            .expect("native handle")
            .as_raw()
        {
            RawWindowHandle::Win32(handle) => handle.hwnd.get() as usize,
            _ => unreachable!("Windows probe"),
        }
    }
    impl Render for Probe {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let title = if self.chinese {
                "GPUI 窗口实验"
            } else {
                "GPUI window probe"
            };
            if self.pet {
                return div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .id("pet-drag")
                            .window_control_area(WindowControlArea::Drag)
                            .rounded_xl()
                            .bg(rgba(0x2563ebcc))
                            .p_4()
                            .text_color(rgb(0xffffff))
                            .child(if self.chinese {
                                "置顶透明窗 · 拖动"
                            } else {
                                "Transparent pet · drag"
                            }),
                    );
            }
            div()
                .size_full()
                .flex()
                .flex_col()
                .bg(rgb(0x172033))
                .text_color(rgb(0xe2e8f0))
                .child(
                    div()
                        .h(px(44.))
                        .flex()
                        .items_center()
                        .bg(rgb(0x263349))
                        .child(
                            div()
                                .id("caption")
                                .flex_1()
                                .h_full()
                                .p_2()
                                .window_control_area(WindowControlArea::Drag)
                                .child(title),
                        )
                        .child(
                            div()
                                .id("minimize")
                                .px_4()
                                .h_full()
                                .window_control_area(WindowControlArea::Min)
                                .on_click(|_, w, _| w.minimize_window())
                                .child("—"),
                        )
                        .child(
                            div()
                                .id("maximize")
                                .px_4()
                                .h_full()
                                .window_control_area(WindowControlArea::Max)
                                .on_click(|_, w, _| w.zoom_window())
                                .child("□"),
                        )
                        .child(
                            div()
                                .id("close")
                                .px_4()
                                .h_full()
                                .window_control_area(WindowControlArea::Close)
                                .on_click(|_, _, cx| cx.quit())
                                .child("×"),
                        ),
                )
                .child(
                    div()
                        .p_4()
                        .flex()
                        .flex_col()
                        .gap_4()
                        .child(if self.chinese {
                            "拖动标题栏；双击最大化；悬停最大化按钮测试 Snap。"
                        } else {
                            "Drag / double-click title bar; hover maximize to test Snap."
                        })
                        .child(if self.chinese {
                            "托盘：显示、隐藏、退出。副窗口不进入任务栏。"
                        } else {
                            "Tray: show, hide, exit. Pet stays off the taskbar."
                        })
                        .child(
                            div()
                                .id("hide")
                                .p_3()
                                .bg(rgb(0x334155))
                                .cursor_pointer()
                                .on_click(|_, w, _| {
                                    native::hide(hwnd(w));
                                    println!("main: hidden via UI");
                                })
                                .child(if self.chinese {
                                    "隐藏到托盘"
                                } else {
                                    "Hide to tray"
                                }),
                        ),
                )
        }
    }

    pub fn run() -> Result<(), String> {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        let smoke = args.iter().any(|s| s == "--smoke");
        if !smoke && !args.iter().any(|s| s == "--window") {
            println!("poc-window --window|--smoke [--namespace com.cli-manager.gpui-poc.TOKEN]; POC_LANG=zh-CN|en-US");
            return Ok(());
        }
        let id = match args.iter().position(|s| s == "--namespace") {
            Some(i) => args.get(i + 1).ok_or("missing namespace")?.clone(),
            None => "com.cli-manager.gpui-poc.window".into(),
        };
        let chinese = std::env::var("POC_LANG").as_deref() != Ok("en-US");
        let (tx, rx) = mpsc::channel();
        let Some(host) = native::NativeHost::acquire(&id, chinese, tx)? else {
            return Ok(());
        };
        let host = Rc::new(RefCell::new(host));
        let host_ui = host.clone();
        gpui_platform::application().run(move |cx: &mut App| {
            let bounds = Bounds::centered(None, size(px(780.), px(420.)), cx);
            let main = cx
                .open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(TitlebarOptions {
                            title: Some(
                                if chinese {
                                    "GPUI 窗口实验"
                                } else {
                                    "GPUI window probe"
                                }
                                .into(),
                            ),
                            appears_transparent: true,
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    |window, cx| {
                        println!("main: hwnd={}", hwnd(window));
                        cx.new(|_| Probe {
                            chinese,
                            pet: false,
                        })
                    },
                )
                .expect("open isolated main window");
            let main_hwnd = main.update(cx, |_, w, _| hwnd(w)).expect("main handle");
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds {
                        origin: gpui::point(px(40.), px(60.)),
                        size: size(px(260.), px(130.)),
                    })),
                    titlebar: Some(TitlebarOptions {
                        title: Some(
                            if chinese {
                                "GPUI 透明窗实验"
                            } else {
                                "GPUI pet probe"
                            }
                            .into(),
                        ),
                        appears_transparent: true,
                        ..Default::default()
                    }),
                    window_background: WindowBackgroundAppearance::Transparent,
                    is_resizable: false,
                    is_minimizable: false,
                    focus: false,
                    ..Default::default()
                },
                |window, cx| {
                    native::configure_pet(hwnd(window)).expect("configure isolated pet");
                    cx.new(|_| Probe { chinese, pet: true })
                },
            )
            .expect("open isolated transparent pet");
            host_ui
                .borrow_mut()
                .add_tray()
                .expect("add isolated tray icon");
            cx.on_window_closed(move |cx, _| {
                if !native::alive(main_hwnd) {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
            cx.spawn(async move |cx| {
                let started = std::time::Instant::now();
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(50))
                        .await;
                    let quit = cx.update(|cx| {
                        for event in rx.try_iter() {
                            match event {
                                native::Event::Show => {
                                    native::show(main_hwnd);
                                    println!("tray: show");
                                }
                                native::Event::Hide => {
                                    native::hide(main_hwnd);
                                    println!("tray: hide");
                                }
                                native::Event::Quit => {
                                    println!("tray: quit");
                                    cx.quit();
                                    return true;
                                }
                                native::Event::Forwarded { cwd, args } => {
                                    println!(
                                        "single-instance: received cwd_chars={} args={args:?}",
                                        cwd.chars().count()
                                    );
                                    native::show(main_hwnd);
                                }
                            }
                        }
                        if smoke && started.elapsed() >= Duration::from_secs(8) {
                            println!("poc-window: smoke timer completed");
                            cx.quit();
                            return true;
                        }
                        false
                    });
                    if quit {
                        break;
                    }
                }
            })
            .detach();
        });
        drop(host);
        Ok(())
    }
}

#[cfg(windows)]
fn main() -> Result<(), String> {
    probe::run()
}
#[cfg(not(windows))]
fn main() {
    eprintln!("poc-window: Windows-only experiment; macOS is deferred");
    std::process::exit(2);
}
