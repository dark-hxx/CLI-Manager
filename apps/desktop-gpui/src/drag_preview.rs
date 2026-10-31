use gpui::{div, prelude::*, px, rgb, Context, Render, Window};

pub struct SessionDragPreview {
    pub label: String,
}

impl Render for SessionDragPreview {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(10.))
            .py(px(6.))
            .bg(rgb(0x30425c))
            .text_color(rgb(0xe8edf4))
            .child(self.label.clone())
    }
}
