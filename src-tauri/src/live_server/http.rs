use std::convert::Infallible;
use std::io::{self, Read};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use cap_std::fs::Dir;
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{
    HeaderValue, ALLOW, CACHE_CONTROL, CONTENT_TYPE, HOST, X_CONTENT_TYPE_OPTIONS,
};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::sync::oneshot;
use tokio_util::io::ReaderStream;

use super::paths::{open_root_dir, resolve_request_path};

pub const RELOAD_ENDPOINT: &str = "/__cli_manager_live_server__/version";
const CACHE_CONTROL_VALUE: &str = "no-store";
const NOSNIFF_VALUE: &str = "nosniff";
const POLL_INTERVAL_MS: u64 = 400;
const MAX_HTML_BYTES: u64 = 16 * 1024 * 1024;

type LiveServerBody = http_body_util::combinators::BoxBody<Bytes, io::Error>;

#[derive(Clone)]
pub struct LiveServerHttpContext {
    root: Arc<Dir>,
    version: Arc<AtomicU64>,
    expected_host: Arc<str>,
}

impl LiveServerHttpContext {
    pub fn new(root: &std::path::Path, version: Arc<AtomicU64>, port: u16) -> Result<Self, String> {
        Ok(Self {
            root: Arc::new(open_root_dir(root)?),
            version,
            expected_host: format!("127.0.0.1:{port}").into(),
        })
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
) -> Result<Response<LiveServerBody>, Infallible> {
    if !has_expected_host(&request, &context.expected_host) {
        return Ok(text_response(StatusCode::FORBIDDEN, "invalid_host", false));
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return Ok(method_not_allowed());
    }

    let head_only = request.method() == Method::HEAD;
    if request.uri().path() == RELOAD_ENDPOINT {
        let version = context.version.load(Ordering::SeqCst).to_string();
        return Ok(text_response(StatusCode::OK, &version, head_only));
    }

    let request_path = request.uri().path().to_string();
    Ok(serve_asset(context, request_path, head_only).await)
}

async fn serve_asset(
    context: LiveServerHttpContext,
    request_path: String,
    head_only: bool,
) -> Response<LiveServerBody> {
    let root = Arc::clone(&context.root);
    let version_before = context.version.load(Ordering::SeqCst);
    let loaded =
        tokio::task::spawn_blocking(move || load_asset(&root, &request_path, head_only)).await;
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
    // If a watcher event lands while the file is being read, use the version
    // captured before the read.  The browser will then observe the newer value
    // on its next poll and reload instead of caching old bytes under a new
    // version.
    let version_after = context.version.load(Ordering::SeqCst);
    let version = reload_version_for_asset(version_before, version_after);
    asset_response(asset, version, head_only)
}

struct LoadedAsset {
    contents: AssetContents,
    content_type: String,
    content_length: u64,
}

enum AssetContents {
    Html(Vec<u8>),
    File(std::fs::File),
    Empty,
}

fn load_asset(root: &Dir, request_path: &str, head_only: bool) -> Result<LoadedAsset, String> {
    let relative = resolve_request_path(request_path)?;
    let path = if root.is_dir(&relative) {
        relative.join("index.html")
    } else {
        relative
    };
    let file = root.open(&path).map_err(map_open_error)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("file_read_failed: {error}"))?;
    if !metadata.is_file() {
        return Err("request_file_not_found".to_string());
    }

    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let is_html = content_type == "text/html";
    let content_length = metadata.len();
    let contents = if is_html {
        let mut bytes = Vec::with_capacity(content_length.min(MAX_HTML_BYTES) as usize);
        let mut limited = file.take(MAX_HTML_BYTES.saturating_add(1));
        limited
            .read_to_end(&mut bytes)
            .map_err(|error| format!("file_read_failed: {error}"))?;
        if bytes.len() as u64 > MAX_HTML_BYTES {
            return Err("asset_too_large".to_string());
        }
        AssetContents::Html(bytes)
    } else if head_only {
        AssetContents::Empty
    } else {
        AssetContents::File(file.into_std())
    };

    Ok(LoadedAsset {
        contents,
        content_type,
        content_length,
    })
}

fn map_open_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "request_file_not_found".to_string(),
        io::ErrorKind::PermissionDenied => "path_outside_root".to_string(),
        _ => format!("file_read_failed: {error}"),
    }
}

fn asset_response(asset: LoadedAsset, version: u64, head_only: bool) -> Response<LiveServerBody> {
    let LoadedAsset {
        contents,
        content_type,
        content_length,
    } = asset;

    match contents {
        AssetContents::Html(bytes) => {
            let body = inject_reload_script(bytes, version);
            let body_length = body.len() as u64;
            response_with_body(
                StatusCode::OK,
                &content_type,
                if head_only {
                    full_body(Vec::new())
                } else {
                    full_body(body)
                },
                Some(body_length),
            )
        }
        AssetContents::File(file) => response_with_body(
            StatusCode::OK,
            &content_type,
            if head_only {
                full_body(Vec::new())
            } else {
                stream_file_body(file)
            },
            if head_only {
                Some(content_length)
            } else {
                None
            },
        ),
        AssetContents::Empty => response_with_body(
            StatusCode::OK,
            &content_type,
            full_body(Vec::new()),
            Some(content_length),
        ),
    }
}

fn full_body(body: Vec<u8>) -> LiveServerBody {
    Full::new(Bytes::from(body))
        .map_err(|never| match never {})
        .boxed()
}

fn stream_file_body(file: std::fs::File) -> LiveServerBody {
    let stream = ReaderStream::new(tokio::fs::File::from_std(file)).map_ok(Frame::data);
    StreamBody::new(stream).boxed()
}

fn response_with_body(
    status: StatusCode,
    content_type: &str,
    body: LiveServerBody,
    content_length: Option<u64>,
) -> Response<LiveServerBody> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static(CACHE_CONTROL_VALUE));
    headers.insert(
        X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static(NOSNIFF_VALUE),
    );
    if let Ok(value) = HeaderValue::from_str(content_type) {
        headers.insert(CONTENT_TYPE, value);
    }
    if let Some(length) = content_length {
        if let Ok(value) = HeaderValue::from_str(&length.to_string()) {
            headers.insert(hyper::header::CONTENT_LENGTH, value);
        }
    }
    response
}

fn text_response(status: StatusCode, message: &str, head_only: bool) -> Response<LiveServerBody> {
    let body = message.as_bytes().to_vec();
    response_with_body(
        status,
        "text/plain; charset=utf-8",
        if head_only {
            full_body(Vec::new())
        } else {
            full_body(body.clone())
        },
        Some(body.len() as u64),
    )
}

fn method_not_allowed() -> Response<LiveServerBody> {
    let mut response = text_response(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", false);
    response
        .headers_mut()
        .insert(ALLOW, HeaderValue::from_static("GET, HEAD"));
    response
}

fn path_error_response(error: &str, head_only: bool) -> Response<LiveServerBody> {
    let status = match error {
        "path_outside_root" => StatusCode::FORBIDDEN,
        "request_file_not_found" => StatusCode::NOT_FOUND,
        "asset_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
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

fn reload_version_for_asset(before: u64, after: u64) -> u64 {
    if before == after {
        after
    } else {
        before
    }
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
