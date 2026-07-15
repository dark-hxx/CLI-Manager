use super::model::{
    HttpMethod, HttpRequestSpec, HttpResponseSnapshot, NotificationError, RequestBody,
};
use reqwest::redirect::Policy;
use reqwest::{Client, Url};
use std::time::{Duration, Instant};

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const CONTROLLED_HEADERS: &[&str] = &["host", "content-length", "transfer-encoding", "connection"];

pub fn build_client() -> Result<Client, NotificationError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .redirect(Policy::none())
        .build()
        .map_err(|err| NotificationError::new("http_client_failed", err.to_string()))
}

pub fn validate_url(raw: &str) -> Result<Url, NotificationError> {
    let url =
        Url::parse(raw.trim()).map_err(|_| NotificationError::new("invalid_url", "invalid url"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(NotificationError::new(
            "invalid_url_scheme",
            "only http/https is allowed",
        ));
    }
    if url.host_str().is_none() {
        return Err(NotificationError::new(
            "invalid_url_host",
            "url host is required",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NotificationError::new(
            "url_credentials_forbidden",
            "url credentials are not allowed",
        ));
    }
    Ok(url)
}

pub fn ensure_safe_header_name(name: &str) -> Result<(), NotificationError> {
    let normalized = name.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized
            .chars()
            .any(|c| !c.is_ascii_alphanumeric() && c != '-')
        || CONTROLLED_HEADERS.contains(&normalized.as_str())
    {
        return Err(NotificationError::new(
            "invalid_header",
            "header is not allowed",
        ));
    }
    Ok(())
}

pub async fn execute(
    client: &Client,
    spec: HttpRequestSpec,
) -> Result<HttpResponseSnapshot, NotificationError> {
    let url = validate_url(&spec.url)?;
    let method = match spec.method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
    };
    let mut request = client.request(method, url);
    for (name, value) in spec.headers {
        ensure_safe_header_name(&name)?;
        request = request.header(name.trim(), value);
    }
    request = match spec.body {
        RequestBody::Empty => request,
        RequestBody::Json(value) => request.json(&value),
        RequestBody::Form(fields) => request.form(&fields),
        RequestBody::Text(text) => request.body(text),
    };

    let started = Instant::now();
    let response = request
        .send()
        .await
        .map_err(|err| NotificationError::new("http_request_failed", err.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|err| NotificationError::new("http_response_failed", err.to_string()))?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(NotificationError::new(
            "response_too_large",
            "response body is too large",
        ));
    }
    Ok(HttpResponseSnapshot {
        status,
        body: body.to_vec(),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

pub fn append_query(mut url: Url, pairs: &[(String, String)]) -> String {
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    url.to_string()
}

pub fn host_for_log(raw: &str) -> String {
    validate_url(raw)
        .ok()
        .and_then(|url| url.host_str().map(ToString::to_string))
        .unwrap_or_else(|| "<invalid-host>".to_string())
}
