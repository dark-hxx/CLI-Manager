use crate::{terminal, DesktopShell};
use gpui::{ClipboardItem, Context, Window};
use std::{path::PathBuf, sync::Arc};

impl DesktopShell {
    pub(crate) fn paste_terminal_item(
        &mut self,
        item: ClipboardItem,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use terminal::clipboard::Content;
        let Some(session_id) = self.sessions.active_session_id().map(str::to_owned) else {
            return;
        };
        match terminal::clipboard::content(item) {
            Content::Paths(paths) => self.drop_terminal_paths(&session_id, &paths, window, cx),
            Content::Text(text) => {
                let mode = self
                    .sessions
                    .get(&session_id)
                    .and_then(|handle| handle.model.lock().ok().map(|model| model.input_mode()))
                    .unwrap_or_default();
                self.send_terminal_bytes_to(
                    &session_id,
                    cli_manager_term_engine::input::encode_paste(text.as_bytes(), mode),
                );
            }
            Content::Image(image) => {
                let Some(handle) = self.sessions.get(&session_id).cloned() else {
                    return;
                };
                self.terminal_input_error = None;
                let generation = handle.cancellation.clone();
                let target_id = session_id.clone();
                let task = self._runtime.spawn(async move {
                    terminal::clipboard::paste_image(&target_id, &handle, image).await
                });
                cx.spawn(async move |this, cx| {
                    let result = task.await.unwrap_or(Err("terminal.image.failed"));
                    let _ =
                        this.update(cx, |this, cx| {
                            if this.sessions.get(&session_id).is_some_and(|current| {
                                Arc::ptr_eq(&current.cancellation, &generation)
                            }) {
                                this.terminal_input_error = result.err();
                                cx.notify();
                            }
                        });
                })
                .detach();
                cx.notify();
            }
            Content::Empty => {}
        }
    }

    pub(crate) fn drop_terminal_paths(
        &mut self,
        session_id: &str,
        paths: &[PathBuf],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if paths.is_empty() {
            return;
        }
        let Some(handle) = self.sessions.get(session_id).cloned() else {
            return;
        };
        self.activate_session(session_id);
        self.terminal_focus_handle.focus(window, cx);
        self.terminal_input_error = None;
        let session_id = session_id.to_owned();
        let paths = paths.to_vec();
        let generation = handle.cancellation.clone();
        let target_id = session_id.clone();
        let task = self._runtime.spawn(async move {
            terminal::path_drop::write_paths(&target_id, &handle, &paths).await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or(Err("terminal.drop.unavailable"));
            let _ = this.update(cx, |this, cx| {
                if this
                    .sessions
                    .get(&session_id)
                    .is_some_and(|current| Arc::ptr_eq(&current.cancellation, &generation))
                {
                    this.terminal_input_error = result.err();
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }
}
