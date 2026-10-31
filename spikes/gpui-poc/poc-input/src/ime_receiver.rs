//! Minimal canvas IME receiver, not a PTY terminal or full text editor.
use crate::composition::Composition;
use gpui::{prelude::*, *};
use std::ops::Range;

pub struct ImeReceiver {
    state: Composition,
    focus: FocusHandle,
    layout: Option<ShapedLine>,
    bounds: Option<Bounds<Pixels>>,
}

impl ImeReceiver {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        cx.on_blur(&focus, window, |this, window, cx| {
            if this.state.marked.is_some() {
                this.state.replace(None, "", None, false);
            }
            this.changed(window, cx);
        })
        .detach();
        Self {
            state: Composition::default(),
            focus,
            layout: None,
            bounds: None,
        }
    }

    fn changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.layout = None;
        window.notify_text_input_changed(&self.focus);
        window.notify_text_selection_changed(&self.focus);
        cx.notify();
    }
}

impl EntityInputHandler for ImeReceiver {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let bytes = self.state.bytes(range);
        *actual = Some(self.state.utf16(bytes.clone()));
        Some(self.state.text[bytes].to_owned())
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.state.utf16(self.state.selected.clone()),
            reversed: false,
        })
    }
    fn set_selected_text_range(
        &mut self,
        range: Range<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.state.selected = self.state.bytes(range);
        self.changed(window, cx);
    }
    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.state.text.encode_utf16().count())
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.state.marked.clone().map(|r| self.state.utf16(r))
    }
    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state.marked = None;
        self.changed(window, cx);
    }
    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.state.replace(range, text, None, false);
        self.changed(window, cx);
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selection: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.state.replace(range, text, selection, true);
        self.changed(window, cx);
    }
    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let layout = self.layout.as_ref()?;
        let bytes = self.state.bytes(range);
        Some(Bounds::from_corners(
            point(
                bounds.left() + layout.x_for_index(bytes.start),
                bounds.top(),
            ),
            point(
                bounds.left() + layout.x_for_index(bytes.end),
                bounds.bottom(),
            ),
        ))
    }
    fn selection_bounds_for_range(
        &mut self,
        range: Range<usize>,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Bounds<Pixels>> {
        self.bounds_for_range(range, bounds, window, cx)
            .into_iter()
            .collect()
    }
    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let local = self.bounds?.localize(&point)?;
        let byte = self.layout.as_ref()?.closest_index_for_x(local.x);
        Some(self.state.utf16(byte..byte).start)
    }
}

impl Render for ImeReceiver {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let prepare_entity = cx.entity();
        let paint_entity = cx.entity();
        div()
            .w_full()
            .p_2()
            .bg(rgb(0x18202b))
            .text_color(rgb(0xe8edf4))
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, window, cx| {
                    this.focus.focus(window, cx);
                    if let Some(local) = this
                        .bounds
                        .and_then(|bounds| bounds.localize(&event.position))
                    {
                        if let Some(layout) = &this.layout {
                            let byte = layout.closest_index_for_x(local.x);
                            this.state.selected = byte..byte;
                            this.changed(window, cx);
                        }
                    }
                }),
            )
            .child(
                canvas(
                    move |_, window, cx| {
                        let this = prepare_entity.read(cx);
                        let style = window.text_style();
                        let base = TextRun {
                            len: this.state.text.len(),
                            font: style.font(),
                            color: style.color,
                            background_color: None,
                            underline: None,
                            strikethrough: None,
                        };
                        let runs = if let Some(marked) = &this.state.marked {
                            vec![
                                TextRun {
                                    len: marked.start,
                                    ..base.clone()
                                },
                                TextRun {
                                    len: marked.len(),
                                    underline: Some(UnderlineStyle {
                                        color: Some(style.color),
                                        thickness: px(1.),
                                        wavy: false,
                                    }),
                                    ..base.clone()
                                },
                                TextRun {
                                    len: this.state.text.len() - marked.end,
                                    ..base
                                },
                            ]
                            .into_iter()
                            .filter(|run| run.len > 0)
                            .collect::<Vec<_>>()
                        } else {
                            vec![base]
                        };
                        window.text_system().shape_line(
                            this.state.text.clone().into(),
                            style.font_size.to_pixels(window.rem_size()),
                            &runs,
                            None,
                        )
                    },
                    move |bounds, line, window, cx| {
                        let this = paint_entity.read(cx);
                        let focus = this.focus.clone();
                        let cursor = line.x_for_index(this.state.selected.end);
                        window.handle_input(
                            &focus,
                            ElementInputHandler::new(bounds, paint_entity.clone()),
                            cx,
                        );
                        let _ = line.paint(
                            bounds.origin,
                            bounds.size.height,
                            TextAlign::Left,
                            None,
                            window,
                            cx,
                        );
                        if focus.is_focused(window) {
                            window.paint_quad(fill(
                                Bounds::new(
                                    point(bounds.left() + cursor, bounds.top()),
                                    size(px(2.), bounds.size.height),
                                ),
                                rgb(0x60a5fa),
                            ));
                        }
                        paint_entity.update(cx, |this, _| {
                            this.layout = Some(line);
                            this.bounds = Some(bounds);
                        });
                    },
                )
                .w_full()
                .h(px(30.)),
            )
    }
}
