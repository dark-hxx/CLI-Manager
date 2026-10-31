use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

pub mod platform;
pub mod probe;
pub mod protocol;

const MAX_BRIDGE_PAYLOAD: usize = 8 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_CREATE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreviewKind {
    Markdown,
    Html,
    LiveServer,
    Pdf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebViewAvailability {
    Available { engine: String, version: String },
    Missing,
    Outdated { version: String, minimum: String },
    Unsupported,
    DisabledByUser,
    Failed { reason: String },
}

impl WebViewAvailability {
    pub fn can_create(&self) -> bool {
        matches!(self, Self::Available { .. })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FallbackAction {
    NativeMarkdown,
    ShowHtmlSource,
    OpenWithDefaultApp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PreviewDecision {
    WebView,
    Fallback(FallbackAction),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreviewRequest {
    pub kind: PreviewKind,
    pub path: Option<PathBuf>,
}

pub fn decide(request: &PreviewRequest, availability: &WebViewAvailability) -> PreviewDecision {
    if availability.can_create() {
        return PreviewDecision::WebView;
    }
    PreviewDecision::Fallback(match request.kind {
        PreviewKind::Markdown => FallbackAction::NativeMarkdown,
        PreviewKind::Html | PreviewKind::LiveServer => FallbackAction::ShowHtmlSource,
        PreviewKind::Pdf => FallbackAction::OpenWithDefaultApp,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostState {
    Idle,
    Probing,
    Creating { started_at: Instant },
    Showing,
    Hidden { since: Instant },
    Failed { reason: String },
    Disposed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HostCommand {
    Create { request: PreviewRequest },
    Navigate { request: PreviewRequest },
    RenderHtml { html: String },
    SetBounds(HostBounds),
    SetVisible(bool),
    Dispose,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor_milli: u32,
}

#[derive(Debug)]
pub struct PreviewHost {
    state: HostState,
    idle_timeout: Duration,
    create_timeout: Duration,
    breaker_open: bool,
    commands: VecDeque<HostCommand>,
    bounds: Option<HostBounds>,
}

impl Default for PreviewHost {
    fn default() -> Self {
        Self::new(DEFAULT_IDLE_TIMEOUT, DEFAULT_CREATE_TIMEOUT)
    }
}

impl PreviewHost {
    pub fn new(idle_timeout: Duration, create_timeout: Duration) -> Self {
        Self {
            state: HostState::Idle,
            idle_timeout,
            create_timeout,
            breaker_open: false,
            commands: VecDeque::new(),
            bounds: None,
        }
    }

    pub fn state(&self) -> &HostState {
        &self.state
    }

    pub fn breaker_open(&self) -> bool {
        self.breaker_open
    }

    pub fn begin_probe(&mut self) -> bool {
        if !matches!(self.state, HostState::Idle | HostState::Disposed) || self.breaker_open {
            return false;
        }
        self.state = HostState::Probing;
        true
    }

    pub fn take_commands(&mut self) -> Vec<HostCommand> {
        self.commands.drain(..).collect()
    }

    pub fn set_bounds(&mut self, bounds: HostBounds) -> bool {
        if self.bounds == Some(bounds) {
            return false;
        }
        self.bounds = Some(bounds);
        if matches!(
            self.state,
            HostState::Creating { .. } | HostState::Showing | HostState::Hidden { .. }
        ) {
            self.queue(HostCommand::SetBounds(bounds));
            true
        } else {
            false
        }
    }

    fn queue(&mut self, command: HostCommand) {
        self.commands.push_back(command);
    }

    pub fn probe(&mut self, availability: &WebViewAvailability, now: Instant) -> bool {
        if !matches!(self.state, HostState::Probing) {
            return false;
        }
        if availability.can_create() {
            self.state = HostState::Creating { started_at: now };
            if let Some(bounds) = self.bounds {
                self.queue(HostCommand::SetBounds(bounds));
            }
        } else {
            self.state = HostState::Failed {
                reason: availability_label(availability),
            };
        }
        true
    }

    pub fn ready(&mut self) -> bool {
        if !matches!(self.state, HostState::Creating { .. }) {
            return false;
        }
        self.state = HostState::Showing;
        true
    }

    pub fn fail(&mut self, reason: impl Into<String>) -> bool {
        if matches!(
            self.state,
            HostState::Probing
                | HostState::Creating { .. }
                | HostState::Showing
                | HostState::Hidden { .. }
        ) {
            self.breaker_open = true;
            self.state = HostState::Failed {
                reason: reason.into(),
            };
            true
        } else {
            false
        }
    }

    pub fn show(&mut self) -> bool {
        if matches!(self.state, HostState::Hidden { .. }) {
            self.state = HostState::Showing;
            self.queue(HostCommand::SetVisible(true));
            true
        } else {
            false
        }
    }

    pub fn hide(&mut self, now: Instant) -> bool {
        if matches!(self.state, HostState::Showing) {
            self.state = HostState::Hidden { since: now };
            self.queue(HostCommand::SetVisible(false));
            true
        } else {
            false
        }
    }

    pub fn close(&mut self) {
        self.state = HostState::Disposed;
        self.queue(HostCommand::Dispose);
    }

    pub fn reset_breaker(&mut self) {
        self.breaker_open = false;
        if matches!(self.state, HostState::Failed { .. }) {
            self.state = HostState::Idle;
        }
    }

    pub fn tick(&mut self, now: Instant) -> bool {
        match self.state {
            HostState::Creating { started_at }
                if now.saturating_duration_since(started_at) >= self.create_timeout =>
            {
                self.breaker_open = true;
                self.state = HostState::Failed {
                    reason: "create_timeout".into(),
                };
                self.queue(HostCommand::SetVisible(false));
                true
            }
            HostState::Hidden { since }
                if now.saturating_duration_since(since) >= self.idle_timeout =>
            {
                self.state = HostState::Disposed;
                self.queue(HostCommand::Dispose);
                true
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OpenResult {
    Fallback {
        action: FallbackAction,
        availability: WebViewAvailability,
    },
    Probing {
        availability: WebViewAvailability,
    },
    Reused,
    Rejected,
}

pub struct PreviewController {
    probe: probe::Probe,
    host: PreviewHost,
    active_request: Option<PreviewRequest>,
}

impl PreviewController {
    pub fn new(probe: probe::Probe, host: PreviewHost) -> Self {
        Self {
            probe,
            host,
            active_request: None,
        }
    }

    pub fn open(&mut self, request: PreviewRequest, now: Instant) -> OpenResult {
        if matches!(
            self.host.state(),
            HostState::Showing | HostState::Hidden { .. }
        ) {
            let was_hidden = matches!(self.host.state(), HostState::Hidden { .. });
            self.active_request = Some(request.clone());
            if was_hidden {
                self.host.show();
            }
            self.host.queue(HostCommand::Navigate { request });
            return OpenResult::Reused;
        }
        let availability = self.probe.probe();
        match decide(&request, &availability) {
            PreviewDecision::Fallback(action) => OpenResult::Fallback {
                action,
                availability,
            },
            PreviewDecision::WebView if self.host.begin_probe() => {
                self.active_request = Some(request);
                self.host.probe(&availability, now);
                if let Some(active_request) = self.active_request.clone() {
                    self.host.queue(HostCommand::Create {
                        request: active_request,
                    });
                }
                OpenResult::Probing { availability }
            }
            PreviewDecision::WebView => OpenResult::Rejected,
        }
    }

    pub fn ready(&mut self) -> bool {
        self.host.ready()
    }

    pub fn failed(&mut self, reason: impl Into<String>) -> bool {
        let changed = self.host.fail(reason);
        if changed {
            self.active_request = None;
        }
        changed
    }

    pub fn hide(&mut self, now: Instant) -> bool {
        self.host.hide(now)
    }

    pub fn show(&mut self) -> bool {
        self.host.show()
    }

    pub fn close(&mut self) {
        self.active_request = None;
        self.host.close();
    }

    pub fn tick(&mut self, now: Instant) -> bool {
        let changed = self.host.tick(now);
        if changed
            && matches!(
                self.host.state(),
                HostState::Failed { .. } | HostState::Disposed
            )
        {
            self.active_request = None;
        }
        changed
    }

    pub fn state(&self) -> &HostState {
        self.host.state()
    }

    pub fn active_request(&self) -> Option<&PreviewRequest> {
        self.active_request.as_ref()
    }

    pub fn availability(&mut self) -> WebViewAvailability {
        self.probe.probe()
    }

    pub fn set_webview_disabled(&mut self, disabled: bool) {
        self.probe.set_disabled(disabled);
        if disabled {
            self.active_request = None;
            self.host.close();
        }
    }

    pub fn retry(&mut self) {
        self.active_request = None;
        self.host.reset_breaker();
        self.probe.clear_cache();
    }

    pub fn take_host_commands(&mut self) -> Vec<HostCommand> {
        self.host.take_commands()
    }

    pub fn render_html(&mut self, html: impl Into<String>) -> bool {
        if matches!(
            self.host.state(),
            HostState::Creating { .. } | HostState::Showing
        ) {
            self.host
                .queue(HostCommand::RenderHtml { html: html.into() });
            true
        } else {
            false
        }
    }

    pub fn set_bounds(&mut self, bounds: HostBounds) -> bool {
        self.host.set_bounds(bounds)
    }
}

fn availability_label(availability: &WebViewAvailability) -> String {
    match availability {
        WebViewAvailability::Available { .. } => "available".into(),
        WebViewAvailability::Missing => "missing".into(),
        WebViewAvailability::Outdated { .. } => "outdated".into(),
        WebViewAvailability::Unsupported => "unsupported".into(),
        WebViewAvailability::DisabledByUser => "disabled_by_user".into(),
        WebViewAvailability::Failed { reason } => reason.clone(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct BridgeMessage {
    pub v: u8,
    pub id: String,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BridgeEvent {
    Ready,
    Error { message: String },
    OpenLink { url: String },
    Copy { text: String },
    Shortcut(ShortcutEvent),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShortcutEvent {
    pub action: String,
    pub key: Option<String>,
    pub alt: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub meta: bool,
}

pub fn parse_bridge_message(bytes: &[u8]) -> Result<BridgeMessage, String> {
    if bytes.len() > MAX_BRIDGE_PAYLOAD {
        return Err("preview_payload_too_large".into());
    }
    let message: BridgeMessage =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if message.v != 1 {
        return Err("preview_protocol_version_unsupported".into());
    }
    if !matches!(
        message.message_type.as_str(),
        "ready" | "error" | "openLink" | "copy" | "shortcut"
    ) {
        return Err("preview_message_type_unsupported".into());
    }
    Ok(message)
}

pub fn parse_bridge_event(bytes: &[u8]) -> Result<BridgeEvent, String> {
    let message = parse_bridge_message(bytes)?;
    match message.message_type.as_str() {
        "ready" => Ok(BridgeEvent::Ready),
        "error" => Ok(BridgeEvent::Error {
            message: required_string(&message.payload, "message")?,
        }),
        "openLink" => Ok(BridgeEvent::OpenLink {
            url: required_string(&message.payload, "url")?,
        }),
        "copy" => Ok(BridgeEvent::Copy {
            text: required_string(&message.payload, "text")?,
        }),
        "shortcut" => Ok(BridgeEvent::Shortcut(ShortcutEvent {
            action: required_string(&message.payload, "action")?,
            key: optional_string(&message.payload, "key")?,
            alt: optional_bool(&message.payload, "alt")?,
            ctrl: optional_bool(&message.payload, "ctrl")?,
            shift: optional_bool(&message.payload, "shift")?,
            meta: optional_bool(&message.payload, "meta")?,
        })),
        _ => Err("preview_message_type_unsupported".into()),
    }
}

fn required_string(payload: &serde_json::Value, field: &str) -> Result<String, String> {
    payload
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("preview_payload_field_invalid:{field}"))
}

fn optional_string(payload: &serde_json::Value, field: &str) -> Result<Option<String>, String> {
    let Some(value) = payload.get(field) else {
        return Ok(None);
    };
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| format!("preview_payload_field_invalid:{field}"))
}

fn optional_bool(payload: &serde_json::Value, field: &str) -> Result<bool, String> {
    let Some(value) = payload.get(field) else {
        return Ok(false);
    };
    value
        .as_bool()
        .ok_or_else(|| format!("preview_payload_field_invalid:{field}"))
}

pub fn resolve_file(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("preview_path_invalid".into());
    }
    let candidate = root.join(relative);
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("preview_path_outside_root".into());
    }
    if is_denied(&canonical) {
        return Err("preview_path_denied".into());
    }
    Ok(canonical)
}

/// Resolves a Markdown-relative local asset from the document directory.
///
/// The URI is decoded before validation so encoded traversal such as
/// `%2e%2e/secret` cannot bypass the path checks. Query strings and fragments
/// are discarded because they are not part of a local filesystem path.
pub fn resolve_local_asset(
    root: &Path,
    document_dir: &Path,
    source: &str,
) -> Result<PathBuf, String> {
    let source = source
        .split_once(['?', '#'])
        .map(|(path, _)| path)
        .unwrap_or(source);
    let decoded = percent_decode(source)?;
    let relative = Path::new(&decoded);
    if decoded.is_empty()
        || decoded.starts_with("//")
        || decoded.contains(':')
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("preview_asset_path_invalid".into());
    }

    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_document = document_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical_document.starts_with(&canonical_root) {
        return Err("preview_asset_document_outside_root".into());
    }
    let canonical = canonical_document
        .join(relative)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("preview_asset_outside_root".into());
    }
    if is_denied(&canonical) {
        return Err("preview_path_denied".into());
    }
    Ok(canonical)
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let Some(high) = bytes.get(index + 1).and_then(|value| hex_digit(*value)) else {
                return Err("preview_asset_uri_invalid".into());
            };
            let Some(low) = bytes.get(index + 2).and_then(|value| hex_digit(*value)) else {
                return Err("preview_asset_uri_invalid".into());
            };
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "preview_asset_uri_invalid_utf8".into())
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn is_denied(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn selects_safe_fallbacks_for_each_preview_kind() {
        let missing = WebViewAvailability::Missing;
        assert_eq!(
            decide(
                &PreviewRequest {
                    kind: PreviewKind::Markdown,
                    path: None
                },
                &missing
            ),
            PreviewDecision::Fallback(FallbackAction::NativeMarkdown)
        );
        assert_eq!(
            decide(
                &PreviewRequest {
                    kind: PreviewKind::Html,
                    path: None
                },
                &missing
            ),
            PreviewDecision::Fallback(FallbackAction::ShowHtmlSource)
        );
        assert_eq!(
            decide(
                &PreviewRequest {
                    kind: PreviewKind::Pdf,
                    path: None
                },
                &missing
            ),
            PreviewDecision::Fallback(FallbackAction::OpenWithDefaultApp)
        );
        assert_eq!(
            decide(
                &PreviewRequest {
                    kind: PreviewKind::Markdown,
                    path: None
                },
                &WebViewAvailability::Available {
                    engine: "webview2".into(),
                    version: "1".into()
                }
            ),
            PreviewDecision::WebView
        );
    }

    #[test]
    fn availability_matrix_keeps_each_preview_usable_without_webview() {
        let unavailable = [
            WebViewAvailability::Missing,
            WebViewAvailability::Outdated {
                version: "1".into(),
                minimum: "2".into(),
            },
            WebViewAvailability::Unsupported,
            WebViewAvailability::DisabledByUser,
            WebViewAvailability::Failed {
                reason: "create_failed".into(),
            },
        ];
        for availability in unavailable {
            assert_eq!(
                decide(
                    &PreviewRequest {
                        kind: PreviewKind::Markdown,
                        path: None,
                    },
                    &availability,
                ),
                PreviewDecision::Fallback(FallbackAction::NativeMarkdown)
            );
            assert_eq!(
                decide(
                    &PreviewRequest {
                        kind: PreviewKind::Html,
                        path: None,
                    },
                    &availability,
                ),
                PreviewDecision::Fallback(FallbackAction::ShowHtmlSource)
            );
            assert_eq!(
                decide(
                    &PreviewRequest {
                        kind: PreviewKind::Pdf,
                        path: None,
                    },
                    &availability,
                ),
                PreviewDecision::Fallback(FallbackAction::OpenWithDefaultApp)
            );
        }
    }

    #[test]
    fn host_times_out_and_reclaims_hidden_instance() {
        let start = Instant::now();
        let mut host = PreviewHost::new(Duration::from_secs(5), Duration::from_secs(2));
        assert!(host.begin_probe());
        assert!(host.probe(
            &WebViewAvailability::Available {
                engine: "test".into(),
                version: "1".into()
            },
            start
        ));
        assert!(host.tick(start + Duration::from_secs(3)));
        assert_eq!(
            host.state(),
            &HostState::Failed {
                reason: "create_timeout".into()
            }
        );
        host.reset_breaker();
        assert!(host.begin_probe());
        assert!(host.probe(
            &WebViewAvailability::Available {
                engine: "test".into(),
                version: "1".into()
            },
            start
        ));
        assert!(host.ready());
        assert!(host.hide(start));
        assert!(host.tick(start + Duration::from_secs(6)));
        assert_eq!(host.state(), &HostState::Disposed);
    }

    #[test]
    fn bridge_rejects_unknown_types_and_large_payloads() {
        let valid = br#"{"v":1,"id":"1","type":"ready","payload":{}}"#;
        assert!(parse_bridge_message(valid).is_ok());
        assert_eq!(
            parse_bridge_message(br#"{"v":1,"id":"1","type":"navigate","payload":{}}"#),
            Err("preview_message_type_unsupported".into())
        );
        assert_eq!(
            parse_bridge_message(&vec![b' '; MAX_BRIDGE_PAYLOAD + 1]),
            Err("preview_payload_too_large".into())
        );
    }

    #[test]
    fn bridge_events_validate_payloads_and_decode_shortcuts() {
        assert_eq!(
            parse_bridge_event(br#"{"v":1,"id":"1","type":"ready","payload":{}}"#),
            Ok(BridgeEvent::Ready)
        );
        assert_eq!(
            parse_bridge_event(br#"{"v":1,"id":"2","type":"shortcut","payload":{"action":"commandPalette","key":"p","ctrl":true}}"#),
            Ok(BridgeEvent::Shortcut(ShortcutEvent {
                action: "commandPalette".into(),
                key: Some("p".into()),
                alt: false,
                ctrl: true,
                shift: false,
                meta: false,
            }))
        );
        assert_eq!(
            parse_bridge_event(br#"{"v":1,"id":"3","type":"copy","payload":{}}"#),
            Err("preview_payload_field_invalid:text".into())
        );
    }

    #[test]
    fn file_resolution_stays_inside_root_and_denies_secrets() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("readme.md"), "ok").unwrap();
        fs::write(directory.path().join(".env"), "secret").unwrap();
        assert!(resolve_file(directory.path(), Path::new("readme.md")).is_ok());
        assert_eq!(
            resolve_file(directory.path(), Path::new("../readme.md")),
            Err("preview_path_invalid".into())
        );
        assert_eq!(
            resolve_file(directory.path(), Path::new(".env")),
            Err("preview_path_denied".into())
        );
    }

    #[test]
    fn local_asset_resolution_decodes_and_contains_relative_paths() {
        let directory = tempdir().unwrap();
        let document = directory.path().join("docs");
        fs::create_dir(&document).unwrap();
        let assets = document.join("assets");
        fs::create_dir(&assets).unwrap();
        fs::write(assets.join("diagram.png"), b"png").unwrap();

        assert_eq!(
            resolve_local_asset(
                directory.path(),
                &document,
                "assets/diagram.png?cache=1#top"
            )
            .unwrap(),
            assets.join("diagram.png").canonicalize().unwrap()
        );
        assert_eq!(
            resolve_local_asset(directory.path(), &document, "%2e%2e/secret.png"),
            Err("preview_asset_path_invalid".into())
        );
        assert_eq!(
            resolve_local_asset(directory.path(), &document, "https://example.test/a.png"),
            Err("preview_asset_path_invalid".into())
        );
    }

    #[test]
    fn controller_returns_fallback_or_drives_the_webview_lifecycle() {
        let request = PreviewRequest {
            kind: PreviewKind::Markdown,
            path: None,
        };
        let now = Instant::now();
        let mut fallback = PreviewController::new(
            probe::Probe::with_availability(WebViewAvailability::Missing),
            PreviewHost::default(),
        );
        assert_eq!(
            fallback.open(request.clone(), now),
            OpenResult::Fallback {
                action: FallbackAction::NativeMarkdown,
                availability: WebViewAvailability::Missing
            }
        );

        let mut controller = PreviewController::new(
            probe::Probe::with_availability(WebViewAvailability::Available {
                engine: "test".into(),
                version: "1".into(),
            }),
            PreviewHost::new(Duration::from_secs(60), Duration::from_secs(3)),
        );
        assert!(matches!(
            controller.open(request, now),
            OpenResult::Probing { .. }
        ));
        assert!(matches!(
            controller.take_host_commands().as_slice(),
            [HostCommand::Create { .. }]
        ));
        assert_eq!(
            controller.active_request().map(|value| value.kind),
            Some(PreviewKind::Markdown)
        );
        assert!(controller.ready());
        assert!(controller.set_bounds(HostBounds {
            x: 10,
            y: 20,
            width: 640,
            height: 480,
            scale_factor_milli: 1500,
        }));
        assert!(controller.hide(now));
        assert_eq!(
            controller.take_host_commands(),
            vec![
                HostCommand::SetBounds(HostBounds {
                    x: 10,
                    y: 20,
                    width: 640,
                    height: 480,
                    scale_factor_milli: 1500,
                }),
                HostCommand::SetVisible(false),
            ]
        );
        assert_eq!(
            controller.open(
                PreviewRequest {
                    kind: PreviewKind::Html,
                    path: Some(PathBuf::from("index.html")),
                },
                now,
            ),
            OpenResult::Reused
        );
        assert_eq!(
            controller.take_host_commands(),
            vec![
                HostCommand::SetVisible(true),
                HostCommand::Navigate {
                    request: PreviewRequest {
                        kind: PreviewKind::Html,
                        path: Some(PathBuf::from("index.html")),
                    },
                }
            ]
        );
        assert!(!controller.show());
        controller.close();
        assert_eq!(controller.take_host_commands(), vec![HostCommand::Dispose]);
        assert_eq!(controller.state(), &HostState::Disposed);
    }

    #[test]
    fn controller_queues_html_after_creation_for_platform_host() {
        let now = Instant::now();
        let mut controller = PreviewController::new(
            probe::Probe::with_availability(WebViewAvailability::Available {
                engine: "test".into(),
                version: "1".into(),
            }),
            PreviewHost::default(),
        );
        assert!(matches!(
            controller.open(
                PreviewRequest {
                    kind: PreviewKind::Html,
                    path: Some(PathBuf::from("index.html")),
                },
                now,
            ),
            OpenResult::Probing { .. }
        ));
        assert!(controller.render_html("<h1>ok</h1>"));
        assert!(matches!(
            controller.take_host_commands().as_slice(),
            [HostCommand::Create { .. }, HostCommand::RenderHtml { html }] if html == "<h1>ok</h1>"
        ));
    }
}
