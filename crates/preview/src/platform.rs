//! Platform WebView2/WKWebView adapter boundary.
//!
//! The platform object is deliberately independent from `PreviewHost`. The
//! host state machine owns lifecycle decisions; this module translates those
//! decisions into a native child WebView once a GPUI window supplies a raw
//! window handle.

#[cfg(any(windows, target_os = "macos"))]
pub mod native {
    use raw_window_handle::HasWindowHandle;
    use std::borrow::Cow;
    use wry::{dpi::PhysicalPosition, dpi::PhysicalSize, Rect, WebView, WebViewBuilder};

    use crate::{parse_bridge_event, protocol::AssetRegistry, BridgeEvent, HostBounds};

    pub struct NativeWebView {
        webview: WebView,
        bridge_events: std::sync::mpsc::Receiver<String>,
    }

    impl NativeWebView {
        pub fn create<W: HasWindowHandle>(
            window: &W,
            url: &str,
            initialization_script: &str,
            assets: AssetRegistry,
        ) -> Result<Self, String> {
            let (sender, receiver) = std::sync::mpsc::channel();
            let webview = WebViewBuilder::new()
                .with_custom_protocol("climgr-preview".into(), move |_, request| {
                    let path = request.uri().path();
                    let asset_uri = protocol_uri(request.uri().to_string().as_str());
                    let (status, mime, body, content_range) = if path == "/app/markdown/" {
                        (
                            200,
                            "text/html; charset=utf-8",
                            preview_shell_html().as_bytes().to_vec(),
                            None,
                        )
                    } else if let Some(range) = request
                        .headers()
                        .get("Range")
                        .and_then(|value| value.to_str().ok())
                    {
                        match assets.serve(&asset_uri, Some(range)) {
                            Ok(response) => (
                                response.status,
                                response.mime,
                                response.body,
                                response.content_range,
                            ),
                            Err(_) => (
                                404,
                                "text/plain; charset=utf-8",
                                b"not found".to_vec(),
                                None,
                            ),
                        }
                    } else if let Ok(response) = assets.serve(&asset_uri, None) {
                        (
                            response.status,
                            response.mime,
                            response.body,
                            response.content_range,
                        )
                    } else {
                        (
                            404,
                            "text/plain; charset=utf-8",
                            b"not found".to_vec(),
                            None,
                        )
                    };
                    let mut response = wry::http::Response::builder()
                        .status(status)
                        .header("Content-Type", mime)
                        .header(
                            "Content-Security-Policy",
                            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
                        );
                    if let Some(content_range) = content_range {
                        response = response.header("Content-Range", content_range);
                    }
                    response
                        .body(Cow::Owned(body))
                        .expect("preview protocol response must be valid")
                })
                .with_navigation_handler(|url| {
                    url.starts_with("climgr-preview://")
                        || url.starts_with("http://climgr-preview.localhost/")
                        || url == "about:blank"
                })
                .with_url(url)
                .with_initialization_script(initialization_script)
                .with_ipc_handler(move |request| {
                    let _ = sender.send(request.into_body());
                })
                .build_as_child(window)
                .map_err(|error| error.to_string())?;
            Ok(Self {
                webview,
                bridge_events: receiver,
            })
        }

        pub fn drain_bridge_events(&self) -> Vec<Result<BridgeEvent, String>> {
            self.bridge_events
                .try_iter()
                .map(|message| parse_bridge_event(message.as_bytes()))
                .collect()
        }

        pub fn load_url(&self, url: &str) -> Result<(), String> {
            self.webview
                .load_url(url)
                .map_err(|error| error.to_string())
        }

        pub fn set_visible(&self, visible: bool) -> Result<(), String> {
            self.webview
                .set_visible(visible)
                .map_err(|error| error.to_string())
        }

        pub fn set_bounds(&self, bounds: HostBounds) -> Result<(), String> {
            self.webview
                .set_bounds(Rect {
                    position: PhysicalPosition::new(bounds.x, bounds.y).into(),
                    size: PhysicalSize::new(bounds.width, bounds.height).into(),
                })
                .map_err(|error| error.to_string())
        }

        pub fn load_html(&self, html: &str) -> Result<(), String> {
            self.webview
                .load_html(html)
                .map_err(|error| error.to_string())
        }
    }

    fn preview_shell_html() -> &'static str {
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>html,body{margin:0;min-height:100%;background:#12161d;color:#e8edf4;font:14px system-ui,sans-serif}body{padding:16px;box-sizing:border-box}</style><main id=\"preview-root\" aria-live=\"polite\">Loading preview…</main>"
    }

    fn protocol_uri(uri: &str) -> String {
        uri.strip_prefix("http://climgr-preview.localhost")
            .map(|path| format!("climgr-preview://{path}"))
            .unwrap_or_else(|| uri.to_owned())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub mod native {
    use crate::BridgeEvent;

    pub struct NativeWebView;

    impl NativeWebView {
        pub fn create<W>(
            _window: &W,
            _url: &str,
            _initialization_script: &str,
            _assets: crate::protocol::AssetRegistry,
        ) -> Result<Self, String> {
            Self::unsupported()
        }

        pub fn unsupported() -> Result<Self, String> {
            Err("preview_platform_unsupported".into())
        }

        pub fn load_url(&self, _url: &str) -> Result<(), String> {
            Err("preview_platform_unsupported".into())
        }

        pub fn load_html(&self, _html: &str) -> Result<(), String> {
            Err("preview_platform_unsupported".into())
        }

        pub fn set_bounds(&self, _bounds: crate::HostBounds) -> Result<(), String> {
            Err("preview_platform_unsupported".into())
        }

        pub fn set_visible(&self, _visible: bool) -> Result<(), String> {
            Err("preview_platform_unsupported".into())
        }

        pub fn drain_bridge_events(&self) -> Vec<Result<BridgeEvent, String>> {
            Vec::new()
        }
    }
}
