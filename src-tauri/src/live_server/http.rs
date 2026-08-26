use std::convert::Infallible;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::header::{
    HeaderValue, ALLOW, CACHE_CONTROL, CONTENT_TYPE, HOST, X_CONTENT_TYPE_OPTIONS,
};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::sync::oneshot;

use super::paths::resolve_request_file;

pub const RELOAD_ENDPOINT: &str = "/__cli_manager_live_server__/version";
const CACHE_CONTROL_VALUE: &str = "no-store";
const NOSNIFF_VALUE: &str = "nosniff";
const POLL_INTERVAL_MS: u64 = 400;

#[derive(Clone)]
pub struct LiveServerHttpContext {
    root: Arc<PathBuf>,
    version: Arc<AtomicU64>,
    expected_host: Arc<str>,
}

impl LiveServerHttpContext {
    pub fn new(root: PathBuf, version: Arc<AtomicU64>, port: u16) -> Self {
        Self {
            root: Arc::new(root),
            version,
            expected_host: format!("127.0.0.1:{port}").into(),
        }
    }
}

pub async fn serve(
    listener: TcpListener,
    context: LiveServerHttpContext,
    mut shutdown_rx: oneshot::Receiver<()>,
) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        log::error!("[live_server] failed to adopt TCP listener");
        return;
    };

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => return,
            accepted = listener.accept() => handle_accept(accepted, context.clone()),
        }
    }
}

fn handle_accept(
    accepted: std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)>,
    context: LiveServerHttpContext,
) {
    let Ok((stream, _)) = accepted else {
        log::warn!("[live_server] failed to accept TCP connection");
        return;
    };
    tokio::spawn(async move {
        let service = service_fn(move |request| handle_request(request, context.clone()));
        let mut builder = hyper::server::conn::http1::Builder::new();
        builder.keep_alive(false);
        if let Err(error) = builder
            .serve_connection(TokioIo::new(stream), service)
            .await
        {
            log::debug!("[live_server] HTTP connection ended: {error}");
        }
    });
}

async fn handle_request(
    request: Request<Incoming>,
    context: LiveServerHttpContext,
) -> Result<Response<Full<Bytes>>, Infallible> {
    if !has_expected_host(&request, &context.expected_host) {
        return Ok(text_response(StatusCode::FORBIDDEN, "invalid_host", false));
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return Ok(method_not_allowed());
    }

    let head_only = request.method() == Method::HEAD;
    if request.uri().path() == RELOAD_ENDPOINT {
        let version = context.version.load(Ordering::Relaxed).to_string();
        return Ok(text_response(StatusCode::OK, &version, head_only));
    }

    let request_path = request.uri().path().to_string();
    Ok(serve_asset(context, request_path, head_only).await)
}

async fn serve_asset(
    context: LiveServerHttpContext,
    request_path: String,
    head_only: bool,
) -> Response<Full<Bytes>> {
    let root = Arc::clone(&context.root);
    let loaded = tokio::task::spawn_blocking(move || load_asset(&root, &request_path)).await;
    let asset = match loaded {
        Ok(Ok(asset)) => asset,
        Ok(Err(error)) => return path_error_response(&error, head_only),
        Err(error) => {
            return text_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("file_task_failed: {error}"),
                head_only,
            )
        }
    };
    let version = context.version.load(Ordering::Relaxed);
    asset_response(asset, version, head_only)
}

struct LoadedAsset {
    bytes: Vec<u8>,
    content_type: String,
    is_html: bool,
}

fn load_asset(root: &Path, request_path: &str) -> Result<LoadedAsset, String> {
    let path = resolve_request_file(root, request_path)?;
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let is_html = content_type == "text/html";
    let bytes = std::fs::read(path).map_err(|error| format!("file_read_failed: {error}"))?;
    Ok(LoadedAsset {
        bytes,
        content_type,
        is_html,
    })
}

fn asset_response(asset: LoadedAsset, version: u64, head_only: bool) -> Response<Full<Bytes>> {
    let bytes = if asset.is_html {
        inject_reload_script(asset.bytes, version)
    } else {
        asset.bytes
    };
    response(ResponseSpec {
        status: StatusCode::OK,
        content_type: &asset.content_type,
        body: bytes,
        head_only,
    })
}

struct ResponseSpec<'a> {
    status: StatusCode,
    content_type: &'a str,
    body: Vec<u8>,
    head_only: bool,
}

fn response(spec: ResponseSpec<'_>) -> Response<Full<Bytes>> {
    let body = if spec.head_only {
        Vec::new()
    } else {
        spec.body
    };
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = spec.status;
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static(CACHE_CONTROL_VALUE));
    headers.insert(
        X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static(NOSNIFF_VALUE),
    );
    if let Ok(value) = HeaderValue::from_str(spec.content_type) {
        headers.insert(CONTENT_TYPE, value);
    }
    response
}

fn text_response(status: StatusCode, message: &str, head_only: bool) -> Response<Full<Bytes>> {
    response(ResponseSpec {
        status,
        content_type: "text/plain; charset=utf-8",
        body: message.as_bytes().to_vec(),
        head_only,
    })
}

fn method_not_allowed() -> Response<Full<Bytes>> {
    let mut response = text_response(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", false);
    response
        .headers_mut()
        .insert(ALLOW, HeaderValue::from_static("GET, HEAD"));
    response
}

fn path_error_response(error: &str, head_only: bool) -> Response<Full<Bytes>> {
    let status = match error {
        "path_outside_root" => StatusCode::FORBIDDEN,
        "request_file_not_found" => StatusCode::NOT_FOUND,
        value if value.starts_with("file_read_failed:") => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    text_response(status, error, head_only)
}

fn has_expected_host(request: &Request<Incoming>, expected: &str) -> bool {
    request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(|host| host.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

fn inject_reload_script(mut html: Vec<u8>, version: u64) -> Vec<u8> {
    let script = reload_script(version);
    let position = find_ascii_case_insensitive(&html, b"</body>").unwrap_or(html.len());
    html.splice(position..position, script);
    html
}

fn reload_script(version: u64) -> Vec<u8> {
    format!(
        r#"<script data-cli-manager-live-server>(()=>{{const endpoint="{RELOAD_ENDPOINT}";let version="{version}";let reported=false;async function poll(){{try{{const response=await fetch(endpoint,{{cache:"no-store"}});if(!response.ok)throw new Error(`HTTP ${{response.status}}`);const next=await response.text();reported=false;if(next!==version)location.reload();}}catch(error){{if(!reported)console.error("CLI-Manager Live Server polling failed",error);reported=true;}}}}setInterval(()=>void poll(),{POLL_INTERVAL_MS});}})();</script>"#
    )
    .into_bytes()
}

fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(left, right)| left.eq_ignore_ascii_case(right))
    })
}

#[cfg(test)]
mod tests;
