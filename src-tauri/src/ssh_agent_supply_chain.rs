use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use reqwest::{redirect, Client, Response, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/dark-hxx/CLI-Manager/releases/latest/download/ssh-agent-release-manifest.json";
const TRUSTED_PUBLIC_KEY: &str = include_str!("../ssh-agent-public-key.txt");
const MANIFEST_MAX_BYTES: usize = 1024 * 1024;
const SIGNATURE_MAX_BYTES: usize = 64 * 1024;
pub const ARTIFACT_MAX_BYTES: usize = 128 * 1024 * 1024;
const PROTOCOL_MAJOR: u16 = 1;
const BUNDLED_MANIFEST_FILE: &str = "ssh-agent-release-manifest.json";
const BUNDLED_SIGNATURE_FILE: &str = "ssh-agent-release-manifest.json.sig";
const BUNDLED_ARTIFACT_FILES: [&str; 2] = [
    "cli-manager-ssh-agent-linux-x86_64",
    "cli-manager-ssh-agent-linux-aarch64",
];

#[derive(Debug, Clone)]
pub enum AgentReleaseSource {
    Bundled(PathBuf),
    Remote,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReleaseManifest {
    pub schema_version: u16,
    pub channel: String,
    pub version: String,
    pub protocol_min: u16,
    pub protocol_max: u16,
    pub published_at: String,
    pub artifacts: Vec<AgentReleaseArtifact>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReleaseArtifact {
    pub target: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct VerifiedRelease {
    pub manifest_url: String,
    pub manifest: AgentReleaseManifest,
    source: AgentReleaseSource,
}

impl VerifiedRelease {
    pub fn distribution_source(&self) -> &'static str {
        match self.source {
            AgentReleaseSource::Bundled(_) => "bundled",
            AgentReleaseSource::Remote => "remote",
        }
    }
}

fn bundled_artifact_file(target: &str) -> Result<&'static str, String> {
    match target {
        "linux-x86_64" => Ok(BUNDLED_ARTIFACT_FILES[0]),
        "linux-aarch64" => Ok(BUNDLED_ARTIFACT_FILES[1]),
        _ => Err("ssh_agent_release_target_missing".to_string()),
    }
}

fn read_bundled_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("ssh_agent_bundled_resource_read_failed:{error}"))?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("ssh_agent_bundled_resource_invalid".to_string());
    }
    std::fs::read(path).map_err(|error| format!("ssh_agent_bundled_resource_read_failed:{error}"))
}

fn bundled_release_presence(root: &Path) -> Result<bool, String> {
    let required = [
        BUNDLED_MANIFEST_FILE,
        BUNDLED_SIGNATURE_FILE,
        BUNDLED_ARTIFACT_FILES[0],
        BUNDLED_ARTIFACT_FILES[1],
    ];
    let present = required
        .iter()
        .filter(|file| root.join(file).is_file())
        .count();
    if present == 0 {
        return Ok(false);
    }
    if present != required.len() {
        return Err("ssh_agent_bundled_resources_incomplete".to_string());
    }
    Ok(true)
}

fn manifest_provenance_url(manifest: &AgentReleaseManifest) -> String {
    manifest
        .artifacts
        .first()
        .and_then(|artifact| Url::parse(&artifact.url).ok())
        .and_then(|url| url.join(BUNDLED_MANIFEST_FILE).ok())
        .map(|url| url.to_string())
        .unwrap_or_else(|| DEFAULT_MANIFEST_URL.to_string())
}

fn try_load_bundled_release(root: &Path) -> Result<Option<VerifiedRelease>, String> {
    if !bundled_release_presence(root)? {
        return Ok(None);
    }
    let manifest_bytes = read_bundled_file(&root.join(BUNDLED_MANIFEST_FILE), MANIFEST_MAX_BYTES)?;
    let signature_bytes =
        read_bundled_file(&root.join(BUNDLED_SIGNATURE_FILE), SIGNATURE_MAX_BYTES)?;
    verify_with_public_key(&manifest_bytes, &signature_bytes, TRUSTED_PUBLIC_KEY)?;
    let manifest: AgentReleaseManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "ssh_agent_manifest_json_invalid".to_string())?;
    validate_manifest(&manifest, false)?;
    Ok(Some(VerifiedRelease {
        manifest_url: manifest_provenance_url(&manifest),
        manifest,
        source: AgentReleaseSource::Bundled(root.to_path_buf()),
    }))
}

fn validate_url(value: &str, allow_http: bool) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "ssh_agent_release_url_invalid".to_string())?;
    if url.scheme() != "https" && !(allow_http && url.scheme() == "http") {
        return Err("ssh_agent_release_https_required".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ssh_agent_release_url_credentials_forbidden".to_string());
    }
    if url.host_str().is_none() || url.query().is_some() || url.fragment().is_some() {
        return Err("ssh_agent_release_url_invalid".to_string());
    }
    Ok(url)
}

fn validate_redirect_target(url: &Url, allow_http: bool) -> Result<(), String> {
    if url.scheme() != "https" && !(allow_http && url.scheme() == "http") {
        return Err("ssh_agent_release_https_required".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ssh_agent_release_url_credentials_forbidden".to_string());
    }
    if url.host_str().is_none() || url.fragment().is_some() {
        return Err("ssh_agent_release_url_invalid".to_string());
    }
    Ok(())
}

fn release_client(allow_http: bool) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.stop();
            }
            if validate_redirect_target(attempt.url(), allow_http).is_ok() {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|error| format!("ssh_agent_release_client_failed:{error}"))
}

async fn read_bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "ssh_agent_release_http_status:{}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("ssh_agent_release_too_large".to_string());
    }
    let mut output = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("ssh_agent_release_download_failed:{error}"))?
    {
        if output.len().saturating_add(chunk.len()) > limit {
            return Err("ssh_agent_release_too_large".to_string());
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn decoded_signature(value: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(value)
        .map_err(|_| "ssh_agent_manifest_signature_invalid".to_string())?
        .trim();
    if text.starts_with("untrusted comment:") {
        return Ok(text.to_string());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| "ssh_agent_manifest_signature_invalid".to_string())?;
    String::from_utf8(decoded).map_err(|_| "ssh_agent_manifest_signature_invalid".to_string())
}

fn verify_with_public_key(
    manifest: &[u8],
    encoded_signature: &[u8],
    public_key: &str,
) -> Result<(), String> {
    let key = PublicKey::decode(public_key)
        .map_err(|_| "ssh_agent_manifest_public_key_invalid".to_string())?;
    let signature = Signature::decode(&decoded_signature(encoded_signature)?)
        .map_err(|_| "ssh_agent_manifest_signature_invalid".to_string())?;
    key.verify(manifest, &signature, true)
        .map_err(|_| "ssh_agent_manifest_signature_invalid".to_string())
}

fn validate_manifest(manifest: &AgentReleaseManifest, allow_http: bool) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err("ssh_agent_manifest_schema_unsupported".to_string());
    }
    Version::parse(manifest.version.trim_start_matches('v'))
        .map_err(|_| "ssh_agent_manifest_version_invalid".to_string())?;
    if manifest.channel.is_empty()
        || !manifest
            .channel
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-')
    {
        return Err("ssh_agent_manifest_channel_invalid".to_string());
    }
    if manifest.published_at.trim().is_empty() {
        return Err("ssh_agent_manifest_published_at_missing".to_string());
    }
    if manifest.protocol_min > PROTOCOL_MAJOR || manifest.protocol_max < PROTOCOL_MAJOR {
        return Err("ssh_agent_manifest_protocol_incompatible".to_string());
    }
    let mut targets = HashSet::new();
    if manifest.artifacts.is_empty() {
        return Err("ssh_agent_manifest_artifacts_missing".to_string());
    }
    for artifact in &manifest.artifacts {
        if !matches!(artifact.target.as_str(), "linux-x86_64" | "linux-aarch64")
            || !targets.insert(artifact.target.as_str())
        {
            return Err("ssh_agent_manifest_target_invalid".to_string());
        }
        validate_url(&artifact.url, allow_http)?;
        if artifact.size == 0 || artifact.size > ARTIFACT_MAX_BYTES as u64 {
            return Err("ssh_agent_manifest_artifact_size_invalid".to_string());
        }
        if artifact.sha256.len() != 64
            || !artifact
                .sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err("ssh_agent_manifest_sha256_invalid".to_string());
        }
    }
    Ok(())
}

pub async fn fetch_verified_release(
    manifest_url: Option<&str>,
    allow_http: bool,
    bundled_root: Option<&Path>,
) -> Result<VerifiedRelease, String> {
    let custom_manifest_url = manifest_url
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if custom_manifest_url.is_none() {
        if let Some(root) = bundled_root {
            if let Some(release) = try_load_bundled_release(root)? {
                return Ok(release);
            }
        }
    }
    let manifest_url = custom_manifest_url.unwrap_or(DEFAULT_MANIFEST_URL);
    let manifest_url = validate_url(manifest_url, allow_http)?;
    let signature_url = validate_url(&format!("{}.sig", manifest_url.as_str()), allow_http)?;
    let client = release_client(allow_http)?;
    let (manifest_response, signature_response) = tokio::try_join!(
        client.get(manifest_url.clone()).send(),
        client.get(signature_url).send()
    )
    .map_err(|error| format!("ssh_agent_release_download_failed:{error}"))?;
    if validate_redirect_target(manifest_response.url(), allow_http).is_err()
        || validate_redirect_target(signature_response.url(), allow_http).is_err()
    {
        return Err("ssh_agent_release_redirect_forbidden".to_string());
    }
    let (manifest_bytes, signature_bytes) = tokio::try_join!(
        read_bounded(manifest_response, MANIFEST_MAX_BYTES),
        read_bounded(signature_response, SIGNATURE_MAX_BYTES)
    )?;
    verify_with_public_key(&manifest_bytes, &signature_bytes, TRUSTED_PUBLIC_KEY)?;
    let manifest: AgentReleaseManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "ssh_agent_manifest_json_invalid".to_string())?;
    validate_manifest(&manifest, allow_http)?;
    Ok(VerifiedRelease {
        manifest_url: manifest_url.to_string(),
        manifest,
        source: AgentReleaseSource::Remote,
    })
}

pub fn select_artifact<'a>(
    manifest: &'a AgentReleaseManifest,
    target: &str,
) -> Result<&'a AgentReleaseArtifact, String> {
    manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.target == target)
        .ok_or_else(|| "ssh_agent_release_target_missing".to_string())
}

pub async fn download_artifact(
    release: &VerifiedRelease,
    artifact: &AgentReleaseArtifact,
    allow_http: bool,
) -> Result<Vec<u8>, String> {
    if let AgentReleaseSource::Bundled(root) = &release.source {
        let file = bundled_artifact_file(&artifact.target)?;
        let bytes = read_bundled_file(&root.join(file), ARTIFACT_MAX_BYTES)?;
        return verify_artifact_bytes(bytes, artifact);
    }
    let url = validate_url(&artifact.url, allow_http)?;
    let response = release_client(allow_http)?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("ssh_agent_artifact_download_failed:{error}"))?;
    if validate_redirect_target(response.url(), allow_http).is_err() {
        return Err("ssh_agent_release_redirect_forbidden".to_string());
    }
    let bytes = read_bounded(response, artifact.size as usize).await?;
    verify_artifact_bytes(bytes, artifact)
}

fn verify_artifact_bytes(
    bytes: Vec<u8>,
    artifact: &AgentReleaseArtifact,
) -> Result<Vec<u8>, String> {
    if bytes.len() as u64 != artifact.size {
        return Err("ssh_agent_artifact_size_mismatch".to_string());
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&artifact.sha256) {
        return Err("ssh_agent_artifact_sha256_mismatch".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_artifact_file, bundled_release_presence, select_artifact, validate_manifest,
        validate_redirect_target, verify_artifact_bytes, verify_with_public_key,
        AgentReleaseArtifact, AgentReleaseManifest, BUNDLED_ARTIFACT_FILES, BUNDLED_MANIFEST_FILE,
    };
    use base64::Engine;
    use reqwest::Url;
    use sha2::{Digest, Sha256};
    use std::fs;

    const SAMPLE_PUBLIC_KEY: &str = "untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SAMPLE_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    fn manifest() -> AgentReleaseManifest {
        AgentReleaseManifest {
            schema_version: 1,
            channel: "temp".into(),
            version: "1.2.3".into(),
            protocol_min: 1,
            protocol_max: 1,
            published_at: "2026-07-20T00:00:00Z".into(),
            artifacts: vec![AgentReleaseArtifact {
                target: "linux-x86_64".into(),
                url: "https://example.com/agent".into(),
                size: 42,
                sha256: "a".repeat(64),
            }],
        }
    }

    #[test]
    fn minisign_rejects_manifest_tampering() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(SAMPLE_SIGNATURE);
        verify_with_public_key(b"test", encoded.as_bytes(), SAMPLE_PUBLIC_KEY).unwrap();
        assert!(
            verify_with_public_key(b"tampered", encoded.as_bytes(), SAMPLE_PUBLIC_KEY).is_err()
        );
    }

    #[test]
    fn manifest_requires_unique_supported_targets() {
        let mut value = manifest();
        validate_manifest(&value, false).unwrap();
        value.artifacts.push(value.artifacts[0].clone());
        assert_eq!(
            validate_manifest(&value, false).unwrap_err(),
            "ssh_agent_manifest_target_invalid"
        );
    }

    #[test]
    fn http_requires_explicit_opt_in() {
        let mut value = manifest();
        value.artifacts[0].url = "http://mirror.example.com/agent".into();
        assert_eq!(
            validate_manifest(&value, false).unwrap_err(),
            "ssh_agent_release_https_required"
        );
        validate_manifest(&value, true).unwrap();
    }

    #[test]
    fn signed_release_urls_reject_queries_and_fragments() {
        let mut value = manifest();
        value.artifacts[0].url = "https://example.com/agent?token=secret".into();
        assert_eq!(
            validate_manifest(&value, false).unwrap_err(),
            "ssh_agent_release_url_invalid"
        );
    }

    #[test]
    fn redirect_targets_allow_https_queries_but_retain_transport_guards() {
        let signed_cdn = Url::parse(
            "https://release-assets.githubusercontent.com/asset?sig=temporary&jwt=temporary",
        )
        .unwrap();
        validate_redirect_target(&signed_cdn, false).unwrap();

        let credentials =
            Url::parse("https://user:secret@example.com/asset?sig=temporary").unwrap();
        assert_eq!(
            validate_redirect_target(&credentials, false).unwrap_err(),
            "ssh_agent_release_url_credentials_forbidden"
        );

        let insecure = Url::parse("http://example.com/asset?sig=temporary").unwrap();
        assert_eq!(
            validate_redirect_target(&insecure, false).unwrap_err(),
            "ssh_agent_release_https_required"
        );
        validate_redirect_target(&insecure, true).unwrap();
    }

    #[test]
    fn artifact_selection_is_exact() {
        let value = manifest();
        assert_eq!(select_artifact(&value, "linux-x86_64").unwrap().size, 42);
        assert!(select_artifact(&value, "linux-aarch64").is_err());
    }

    #[test]
    fn bundled_artifact_names_are_fixed_by_target() {
        assert_eq!(
            bundled_artifact_file("linux-x86_64").unwrap(),
            BUNDLED_ARTIFACT_FILES[0]
        );
        assert_eq!(
            bundled_artifact_file("linux-aarch64").unwrap(),
            BUNDLED_ARTIFACT_FILES[1]
        );
        assert!(bundled_artifact_file("linux-riscv64").is_err());
    }

    #[test]
    fn bundled_release_rejects_partial_resources() {
        let root =
            std::env::temp_dir().join(format!("cli-manager-agent-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(!bundled_release_presence(&root).unwrap());
        fs::write(root.join(BUNDLED_MANIFEST_FILE), b"{}").unwrap();
        assert_eq!(
            bundled_release_presence(&root).unwrap_err(),
            "ssh_agent_bundled_resources_incomplete"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_bytes_require_exact_size_and_hash() {
        let bytes = b"agent".to_vec();
        let artifact = AgentReleaseArtifact {
            target: "linux-x86_64".into(),
            url: "https://example.com/agent".into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        assert_eq!(
            verify_artifact_bytes(bytes.clone(), &artifact).unwrap(),
            bytes
        );
        let mut wrong_size = artifact.clone();
        wrong_size.size += 1;
        assert_eq!(
            verify_artifact_bytes(bytes.clone(), &wrong_size).unwrap_err(),
            "ssh_agent_artifact_size_mismatch"
        );
        let mut wrong_hash = artifact;
        wrong_hash.sha256 = "0".repeat(64);
        assert_eq!(
            verify_artifact_bytes(bytes, &wrong_hash).unwrap_err(),
            "ssh_agent_artifact_sha256_mismatch"
        );
    }
}
