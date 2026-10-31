use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use crate::resolve_file;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NavigationDecision {
    Internal,
    LiveServer,
    External,
    Blocked,
}

pub fn classify_navigation(url: &str, live_server_port: Option<u16>) -> NavigationDecision {
    if url.starts_with("climgr-preview://app/")
        || url.starts_with("climgr-preview://file/")
        || url.starts_with("climgr-preview://pdf/")
    {
        return NavigationDecision::Internal;
    }
    if let Some((host, port)) = http_authority(url) {
        if matches!(host, "127.0.0.1" | "localhost") && live_server_port == Some(port) {
            return NavigationDecision::LiveServer;
        }
        return NavigationDecision::External;
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        return NavigationDecision::External;
    }
    if url.starts_with("mailto:") {
        NavigationDecision::External
    } else {
        NavigationDecision::Blocked
    }
}

fn http_authority(url: &str) -> Option<(&str, u16)> {
    let remainder = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let authority = remainder.split(['/', '?', '#']).next()?;
    if let Some((host, port)) = authority.rsplit_once(':') {
        return Some((host, port.parse().ok()?));
    }
    Some((
        authority,
        if url.starts_with("https://") { 443 } else { 80 },
    ))
}

pub fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" | "mdown" => "text/markdown; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolResponse {
    pub status: u16,
    pub mime: &'static str,
    pub body: Vec<u8>,
    pub content_range: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct AssetRegistry {
    roots: HashMap<String, PathBuf>,
    pdfs: HashMap<String, PathBuf>,
}

impl AssetRegistry {
    pub fn register_root(
        &mut self,
        token: impl Into<String>,
        root: impl Into<PathBuf>,
    ) -> Result<(), String> {
        let token = token.into();
        if token.is_empty() || token.contains('/') || token.contains('\\') {
            return Err("preview_token_invalid".into());
        }
        let root = root
            .into()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !root.is_dir() {
            return Err("preview_root_invalid".into());
        }
        self.roots.insert(token, root);
        Ok(())
    }

    pub fn register_pdf(
        &mut self,
        token: impl Into<String>,
        root: impl AsRef<Path>,
        relative: impl AsRef<Path>,
    ) -> Result<(), String> {
        let token = token.into();
        let path = resolve_file(root.as_ref(), relative.as_ref())?;
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            != Some("pdf".into())
        {
            return Err("preview_pdf_extension_required".into());
        }
        self.pdfs.insert(token, path);
        Ok(())
    }

    pub fn serve(&self, uri: &str, range: Option<&str>) -> Result<ProtocolResponse, String> {
        let route = uri
            .strip_prefix("climgr-preview://")
            .ok_or_else(|| "preview_uri_invalid".to_owned())?;
        let route = route
            .split_once(['?', '#'])
            .map(|(value, _)| value)
            .unwrap_or(route);
        let (kind, remainder) = route.split_once('/').unwrap_or((route, ""));
        let mut parts = remainder.splitn(2, '/');
        match kind {
            "file" => {
                let token = decode_component(parts.next().unwrap_or_default())?;
                let relative = decode_component(parts.next().unwrap_or_default())?;
                let root = self
                    .roots
                    .get(&token)
                    .ok_or_else(|| "preview_token_not_found".to_owned())?;
                let file = resolve_file(root, Path::new(&relative))?;
                read_response(&file, range)
            }
            "pdf" => {
                let token = decode_component(parts.next().unwrap_or_default())?;
                let file = self
                    .pdfs
                    .get(&token)
                    .ok_or_else(|| "preview_token_not_found".to_owned())?;
                read_response(file, range)
            }
            _ => Err("preview_route_not_found".into()),
        }
    }
}

fn read_response(path: &Path, range: Option<&str>) -> Result<ProtocolResponse, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("preview_asset_not_file".into());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if let Some(range) = range {
        let selected = parse_range(range, bytes.len() as u64)?;
        return Ok(ProtocolResponse {
            status: 206,
            mime: mime_for_path(path),
            body: bytes[selected.start as usize..=selected.end as usize].to_vec(),
            content_range: Some(format!(
                "bytes {}-{}/{}",
                selected.start,
                selected.end,
                bytes.len()
            )),
        });
    }
    Ok(ProtocolResponse {
        status: 200,
        mime: mime_for_path(path),
        body: bytes,
        content_range: None,
    })
}

fn decode_component(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes
                .get(index + 1)
                .and_then(|value| hex_value(*value))
                .ok_or_else(|| "preview_uri_invalid".to_owned())?;
            let low = bytes
                .get(index + 2)
                .and_then(|value| hex_value(*value))
                .ok_or_else(|| "preview_uri_invalid".to_owned())?;
            output.push(((high << 4) | low) as u8);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| "preview_uri_invalid_utf8".into())
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn len(self) -> u64 {
        self.end - self.start + 1
    }
}

pub fn parse_range(value: &str, length: u64) -> Result<ByteRange, String> {
    if length == 0 || !value.starts_with("bytes=") {
        return Err("preview_range_invalid".into());
    }
    let raw = &value[6..];
    if raw.contains(',') {
        return Err("preview_range_multiple_unsupported".into());
    }
    let range = raw;
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| "preview_range_invalid".to_owned())?;
    let (start, end) = if start.is_empty() {
        let suffix: u64 = end
            .parse()
            .map_err(|_| "preview_range_invalid".to_owned())?;
        if suffix == 0 {
            return Err("preview_range_invalid".into());
        }
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start: u64 = start
            .parse()
            .map_err(|_| "preview_range_invalid".to_owned())?;
        if start >= length {
            return Err("preview_range_unsatisfiable".into());
        }
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse()
                .map_err(|_| "preview_range_invalid".to_owned())?
        };
        (start, end.min(length - 1))
    };
    if start > end {
        return Err("preview_range_unsatisfiable".into());
    }
    Ok(ByteRange { start, end })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn only_allows_preview_and_configured_live_server_origins() {
        assert_eq!(
            classify_navigation("climgr-preview://app/markdown/", None),
            NavigationDecision::Internal
        );
        assert_eq!(
            classify_navigation("http://127.0.0.1:4173/index.html", Some(4173)),
            NavigationDecision::LiveServer
        );
        assert_eq!(
            classify_navigation("http://127.0.0.1:4174/index.html", Some(4173)),
            NavigationDecision::External
        );
        assert_eq!(
            classify_navigation("https://example.com", None),
            NavigationDecision::External
        );
        assert_eq!(
            classify_navigation("javascript:alert(1)", None),
            NavigationDecision::Blocked
        );
    }

    #[test]
    fn maps_preview_file_types_to_safe_mimes() {
        assert_eq!(
            mime_for_path(Path::new("readme.md")),
            "text/markdown; charset=utf-8"
        );
        assert_eq!(mime_for_path(Path::new("document.pdf")), "application/pdf");
        assert_eq!(
            mime_for_path(Path::new("unknown.bin")),
            "application/octet-stream"
        );
    }

    #[test]
    fn parses_single_ranges_and_clamps_end() {
        assert_eq!(
            parse_range("bytes=2-5", 10).unwrap(),
            ByteRange { start: 2, end: 5 }
        );
        assert_eq!(
            parse_range("bytes=7-", 10).unwrap(),
            ByteRange { start: 7, end: 9 }
        );
        assert_eq!(
            parse_range("bytes=-3", 10).unwrap(),
            ByteRange { start: 7, end: 9 }
        );
        assert_eq!(
            parse_range("bytes=1-2,5-6", 10),
            Err("preview_range_multiple_unsupported".into())
        );
        assert_eq!(
            parse_range("bytes=10-", 10),
            Err("preview_range_unsatisfiable".into())
        );
    }

    #[test]
    fn serves_tokenized_files_and_pdf_ranges_inside_registered_roots() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("assets")).unwrap();
        fs::write(directory.path().join("assets/page.html"), b"<p>ok</p>").unwrap();
        fs::write(directory.path().join("document.pdf"), b"0123456789").unwrap();

        let mut registry = AssetRegistry::default();
        registry.register_root("project", directory.path()).unwrap();
        registry
            .register_pdf("manual", directory.path(), "document.pdf")
            .unwrap();

        let html = registry
            .serve("climgr-preview://file/project/assets/page.html", None)
            .unwrap();
        assert_eq!(html.status, 200);
        assert_eq!(html.mime, "text/html; charset=utf-8");
        assert_eq!(html.body, b"<p>ok</p>");

        let pdf = registry
            .serve("climgr-preview://pdf/manual", Some("bytes=2-5"))
            .unwrap();
        assert_eq!(pdf.status, 206);
        assert_eq!(pdf.body, b"2345");
        assert_eq!(pdf.content_range.as_deref(), Some("bytes 2-5/10"));

        assert_eq!(
            registry.serve("climgr-preview://file/project/%2e%2e/document.pdf", None),
            Err("preview_path_invalid".into())
        );
    }
}
