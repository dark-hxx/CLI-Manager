use crate::DesktopShell;
use gpui::{Bounds, ClipboardItem, Context, Pixels, Window, WindowVisibility};
use std::path::Path;
use std::time::Instant;

impl DesktopShell {
    pub(crate) fn start_preview_reaper(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let shell = cx.entity().downgrade();
        window
            .spawn(cx, async move |cx| loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                let update = cx.update(|window, app| {
                    shell.update(app, |shell, cx| {
                        shell.drain_preview_bridge_events(window, cx);
                        if shell.preview_controller.tick(Instant::now()) {
                            shell.flush_preview_commands(window);
                        }
                    })
                });
                if update.is_err() {
                    break;
                }
            })
            .detach();
    }

    pub(crate) fn sync_preview_bounds(&mut self, window: &mut Window) {
        let Some(bounds) = self.preview_slot_bounds else {
            return;
        };
        let scale_factor = window.scale_factor();
        let _ = self
            .preview_controller
            .set_bounds(cli_manager_preview::HostBounds {
                x: (bounds.origin.x.as_f32() * scale_factor).round() as i32,
                y: (bounds.origin.y.as_f32() * scale_factor).round() as i32,
                width: (bounds.size.width.as_f32().max(0.0) * scale_factor).round() as u32,
                height: (bounds.size.height.as_f32().max(0.0) * scale_factor).round() as u32,
                scale_factor_milli: (scale_factor.max(0.1) * 1000.0).round() as u32,
            });
        self.flush_preview_commands(window);
    }

    pub(crate) fn set_preview_slot_bounds(&mut self, bounds: Bounds<Pixels>, window: &mut Window) {
        self.preview_slot_bounds = Some(bounds);
        self.sync_preview_bounds(window);
    }

    pub(crate) fn sync_preview_airspace(&mut self, window: &mut Window) {
        let modal_open = self.command_palette_open
            || self.settings_open
            || self.exit_prompt
            || self.restore_prompt_project.is_some()
            || self.file_operation_prompt.is_some()
            || self.file_close_prompt.is_some()
            || self.file_delete_prompt.is_some()
            || self.git_revert_prompt.is_some()
            || self.git_commit_prompt
            || self.git_checkout_prompt.is_some()
            || self.worktree_prompt.is_some();
        self.overlay_registry.clear();
        if modal_open {
            self.overlay_registry.replace(
                "active-modal",
                crate::overlay::OverlayRect::from_bounds(window.bounds()),
            );
        }
        let occluded = self
            .preview_slot_bounds
            .is_some_and(|bounds| self.overlay_registry.intersects_bounds(bounds));
        if self.preview_occluded == occluded {
            return;
        }
        self.preview_occluded = occluded;
        if occluded {
            let _ = self.preview_controller.hide(Instant::now());
        } else {
            let _ = self.preview_controller.show();
        }
        self.flush_preview_commands(window);
    }

    pub(crate) fn sync_preview_visibility(
        &mut self,
        visibility: WindowVisibility,
        window: &mut Window,
    ) {
        if visibility == WindowVisibility::Visible {
            let _ = self.preview_controller.show();
        } else {
            let _ = self.preview_controller.hide(Instant::now());
        }
        self.flush_preview_commands(window);
    }

    pub(crate) fn start_preview_host(
        &mut self,
        relative_path: &str,
        content: &str,
        window: &mut Window,
    ) {
        let kind = match Path::new(relative_path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "md" | "markdown" => cli_manager_preview::PreviewKind::Markdown,
            "html" | "htm" => cli_manager_preview::PreviewKind::Html,
            "pdf" => cli_manager_preview::PreviewKind::Pdf,
            _ => return,
        };
        if kind == cli_manager_preview::PreviewKind::Pdf && self.preview_webview.is_some() {
            self.preview_controller.close();
            self.flush_preview_commands(window);
        }
        self.preview_assets = cli_manager_preview::protocol::AssetRegistry::default();
        if let Some(root) = match &self.file_tree {
            crate::files::FileTreeState::Ready { root, .. } => Some(root.clone()),
            _ => None,
        } {
            let _ = self.preview_assets.register_root("project", &root);
            if kind == cli_manager_preview::PreviewKind::Pdf {
                let _ = self
                    .preview_assets
                    .register_pdf("current", root, relative_path);
            }
        }
        let _ = self.preview_controller.open(
            cli_manager_preview::PreviewRequest {
                kind,
                path: Some(relative_path.into()),
            },
            Instant::now(),
        );
        let _ = self
            .preview_controller
            .render_html(renderable_html(relative_path, content));
        self.flush_preview_commands(window);
    }

    pub(crate) fn flush_preview_commands(&mut self, window: &mut Window) {
        for command in self.preview_controller.take_host_commands() {
            let result = match command {
                cli_manager_preview::HostCommand::Create { request } => {
                    if self.preview_webview.is_none() {
                        let initial_url = match request.kind {
                            cli_manager_preview::PreviewKind::Pdf => "climgr-preview://pdf/current",
                            _ => "climgr-preview://app/markdown/",
                        };
                        match cli_manager_preview::platform::native::NativeWebView::create(
                            window,
                            initial_url,
                            &self.keymap.preview_bridge_script(),
                            self.preview_assets.clone(),
                        ) {
                            Ok(webview) => {
                                self.preview_webview = Some(webview);
                                let _ = self.preview_controller.ready();
                                Ok(())
                            }
                            Err(error) => Err(error),
                        }
                    } else {
                        let _ = self.preview_controller.ready();
                        Ok(())
                    }
                }
                cli_manager_preview::HostCommand::Navigate { request } => self
                    .preview_webview
                    .as_ref()
                    .ok_or_else(|| "preview_webview_missing".to_owned())
                    .and_then(|webview| {
                        let url = match request.kind {
                            cli_manager_preview::PreviewKind::Pdf => "climgr-preview://pdf/current",
                            _ => "climgr-preview://app/markdown/",
                        };
                        webview.load_url(url)
                    }),
                cli_manager_preview::HostCommand::RenderHtml { html } => self
                    .preview_webview
                    .as_ref()
                    .ok_or_else(|| "preview_webview_missing".to_owned())
                    .and_then(|webview| webview.load_html(&html)),
                cli_manager_preview::HostCommand::SetBounds(bounds) => self
                    .preview_webview
                    .as_ref()
                    .ok_or_else(|| "preview_webview_missing".to_owned())
                    .and_then(|webview| webview.set_bounds(bounds)),
                cli_manager_preview::HostCommand::SetVisible(visible) => self
                    .preview_webview
                    .as_ref()
                    .ok_or_else(|| "preview_webview_missing".to_owned())
                    .and_then(|webview| webview.set_visible(visible)),
                cli_manager_preview::HostCommand::Dispose => {
                    self.preview_webview = None;
                    Ok(())
                }
            };
            if let Err(error) = result {
                self.preview_webview = None;
                let _ = self.preview_controller.failed(error);
                break;
            }
        }
    }

    fn drain_preview_bridge_events(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let events = self
            .preview_webview
            .as_ref()
            .map(|webview| webview.drain_bridge_events())
            .unwrap_or_default();
        for event in events {
            let Ok(event) = event else {
                continue;
            };
            match event {
                cli_manager_preview::BridgeEvent::Ready => {
                    let _ = self.preview_controller.ready();
                }
                cli_manager_preview::BridgeEvent::Error { message } => {
                    let _ = self.preview_controller.failed(message);
                }
                cli_manager_preview::BridgeEvent::OpenLink { url } => {
                    Self::open_terminal_url(&url);
                }
                cli_manager_preview::BridgeEvent::Copy { text } => {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
                cli_manager_preview::BridgeEvent::Shortcut(shortcut) => {
                    self.dispatch_preview_shortcut(&shortcut, window, cx);
                }
            }
        }
    }

    fn dispatch_preview_shortcut(
        &mut self,
        shortcut: &cli_manager_preview::ShortcutEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if shortcut
            .key
            .as_deref()
            .is_some_and(|key| key.eq_ignore_ascii_case("escape"))
        {
            self.terminal_focus_handle.focus(window, cx);
            return;
        }
        match shortcut.action.as_str() {
            "commandPalette" => self.toggle_command_palette(),
            "newTerminal" => {
                self.split_active_terminal(crate::workspace::pane_tree::SplitDirection::Right)
            }
            "closeTerminal" => self.close_active_terminal(),
            "sessionHistory" => self.open_history(cx),
            "copyTerminalSelection" => {
                if let Some(text) = self.selected_terminal_text() {
                    cx.write_to_clipboard(ClipboardItem::new_string(text));
                }
            }
            "resizeLeft" | "resizeUp" | "resizeRight" | "resizeDown" => {
                let delta = if matches!(shortcut.action.as_str(), "resizeLeft" | "resizeUp") {
                    -500
                } else {
                    500
                };
                if let Some(workspace) = self.workspace_sessions.as_mut() {
                    workspace.panes_mut().resize_active(delta);
                }
                self.persist_workspace_snapshot();
                self.terminal_size = None;
            }
            _ => {}
        }
        cx.notify();
    }
}

fn renderable_html(relative_path: &str, content: &str) -> String {
    let escaped = content
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    if relative_path
        .rsplit_once('.')
        .map(|(_, extension)| matches!(extension.to_ascii_lowercase().as_str(), "html" | "htm"))
        .unwrap_or(false)
    {
        format!(
            "<base href=\"climgr-preview://file/project/{}/\">{content}",
            encode_uri_path(relative_path)
        )
    } else {
        format!(
            "<!doctype html><meta charset=\"utf-8\"><style>body{{margin:0;padding:16px;background:#12161d;color:#e8edf4;font:14px monospace;white-space:pre-wrap}}</style><body>{escaped}</body>"
        )
    }
}

fn encode_uri_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
            encoded.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap());
        }
    }
    encoded
}
