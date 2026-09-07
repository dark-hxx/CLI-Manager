use reqwest::{redirect, Client, Response, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const RELEASES_API_URL: &str =
    "https://api.github.com/repos/chenhg5/cc-connect/releases?per_page=30";
const RELEASE_DOWNLOAD_PATH_PREFIX: &str = "/chenhg5/cc-connect/releases/download/";
const TRUST_STORE_FILE_NAME: &str = "cc-connect-trusted-releases.json";
const TRUST_STORE_SCHEMA_VERSION: u16 = 1;
const MAX_TRUSTED_RELEASES: usize = 32;
const MAX_TRUST_STORE_BYTES: u64 = 256 * 1024;
const MAX_RELEASES_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES: usize = 256 * 1024;
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
const MAX_BINARY_BYTES: usize = 128 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES: u64 = 1024 * 1024;
const MAX_CONFIG_BYTES: usize = 4 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CcConnectUpdateChannel {
    #[default]
    Stable,
    Prerelease,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CcConnectCheckUpdateRequest {
    #[serde(default)]
    pub channel: CcConnectUpdateChannel,
    #[serde(default)]
    pub current_version: Option<String>,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CcConnectInstallUpdateRequest {
    pub executable_path: String,
    #[serde(default)]
    pub current_version: Option<String>,
    #[serde(default)]
    pub channel: CcConnectUpdateChannel,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CcConnectUpdateCheck {
    pub channel: CcConnectUpdateChannel,
    pub current_version: Option<String>,
    pub latest_version: String,
    pub update_available: bool,
    pub prerelease: bool,
    pub release_url: String,
    pub published_at: Option<String>,
    pub asset_name: String,
    pub download_size: u64,
    pub checksum_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CcConnectUpdateResult {
    pub channel: CcConnectUpdateChannel,
    pub previous_version: Option<String>,
    pub installed_version: String,
    pub executable_path: String,
    pub sha256: String,
    pub release_url: String,
    pub asset_name: String,
    pub package_metadata_updated: bool,
    pub updated: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Debug, Clone)]
struct ReleasePlan {
    version: Version,
    html_url: String,
    prerelease: bool,
    published_at: Option<String>,
    archive: GithubAsset,
    checksums: GithubAsset,
    archive_name: String,
    binary_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CcConnectTrustedRelease {
    pub version: String,
    pub sha256: String,
    pub asset_name: String,
    pub release_url: String,
    pub verified_at_ms: i64,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrustedReleaseStore {
    schema_version: u16,
    releases: Vec<CcConnectTrustedRelease>,
}

#[derive(Debug)]
struct NpmPackageSnapshot {
    path: PathBuf,
    original: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct CcConnectPreparedUpdate {
    channel: CcConnectUpdateChannel,
    executable: PathBuf,
    current_sha256: String,
    previous_version: Option<Version>,
    plan: ReleasePlan,
    binary: Option<Vec<u8>>,
    binary_sha256: Option<String>,
}

impl CcConnectPreparedUpdate {
    pub(crate) fn executable_path(&self) -> &Path {
        &self.executable
    }
}

pub(crate) fn is_compatible_version(raw: &str) -> bool {
    parse_semver(raw).is_some_and(|version| compatible_version(&version))
}

pub(crate) fn trusted_version_for_sha256(sha256: &str) -> Result<Option<String>, String> {
    trusted_version_for_sha256_at(&trust_store_path()?, sha256)
}

pub(crate) async fn check_update(
    request: CcConnectCheckUpdateRequest,
) -> Result<CcConnectUpdateCheck, String> {
    let current = request
        .current_version
        .as_deref()
        .map(parse_semver_any_result)
        .transpose()?;
    let client = release_client(request.proxy_enabled, request.proxy_url.as_deref())?;
    let plan = fetch_release_plan(&client, request.channel).await?;
    let checksum_sha256 = fetch_binary_checksum(&client, &plan).await?;
    Ok(update_check_from_plan(
        request.channel,
        current.as_ref(),
        &plan,
        checksum_sha256,
    ))
}

// Downloading and verification intentionally happen before this value is handed to the
// manager. The manager can keep cc-connect running during `prepare_update`, then stop it
// only while calling `apply_prepared_update` under its operation lock.
pub(crate) async fn prepare_update(
    request: CcConnectInstallUpdateRequest,
) -> Result<CcConnectPreparedUpdate, String> {
    let executable = validate_update_target(&request.executable_path)?;
    let current_sha256 = super::sha256_file(&executable)?;
    let current_version = trusted_installed_version(&current_sha256);
    if let (Some(expected), Some(current)) =
        (request.current_version.as_deref(), current_version.as_ref())
    {
        let expected = parse_semver_result(expected)?;
        if &expected != current {
            return Err("cc_connect_update_current_version_changed".to_string());
        }
    }

    let client = release_client(request.proxy_enabled, request.proxy_url.as_deref())?;
    let plan = fetch_release_plan(&client, request.channel).await?;
    if current_version
        .as_ref()
        .is_some_and(|current| plan.version <= *current)
    {
        return Ok(CcConnectPreparedUpdate {
            channel: request.channel,
            executable,
            current_sha256,
            previous_version: current_version,
            plan,
            binary: None,
            binary_sha256: None,
        });
    }

    let (checksums_bytes, archive_bytes) = tokio::try_join!(
        download_asset(&client, &plan.checksums, MAX_CHECKSUMS_BYTES),
        download_asset(&client, &plan.archive, MAX_ARCHIVE_BYTES),
    )?;
    verify_api_digest(&plan.checksums, &checksums_bytes)?;
    verify_api_digest(&plan.archive, &archive_bytes)?;
    let checksums = parse_checksums(&checksums_bytes)?;
    verify_named_checksum(&checksums, &plan.archive_name, &archive_bytes)?;
    let target_parent = executable
        .parent()
        .ok_or_else(|| "cc_connect_update_target_parent_missing".to_string())?;
    let binary = extract_release_binary(
        &archive_bytes,
        &plan.archive_name,
        &plan.binary_name,
        target_parent,
    )?;
    verify_named_checksum(&checksums, &plan.binary_name, &binary)?;
    let binary_sha256 = sha256_bytes(&binary);

    Ok(CcConnectPreparedUpdate {
        channel: request.channel,
        executable,
        current_sha256,
        previous_version: current_version,
        plan,
        binary: Some(binary),
        binary_sha256: Some(binary_sha256),
    })
}

pub(crate) fn apply_prepared_update(
    prepared: CcConnectPreparedUpdate,
) -> Result<CcConnectUpdateResult, String> {
    let current_target = validate_update_target(&super::user_path_string(&prepared.executable))?;
    if current_target != prepared.executable
        || super::sha256_file(&current_target)? != prepared.current_sha256
    {
        return Err("cc_connect_update_target_changed".to_string());
    }

    let Some(binary) = prepared.binary else {
        let installed_version = prepared
            .previous_version
            .as_ref()
            .ok_or_else(|| "cc_connect_update_current_version_unknown".to_string())?;
        return Ok(CcConnectUpdateResult {
            channel: prepared.channel,
            previous_version: Some(installed_version.to_string()),
            installed_version: installed_version.to_string(),
            executable_path: super::user_path_string(&prepared.executable),
            sha256: prepared.current_sha256,
            release_url: prepared.plan.html_url,
            asset_name: prepared.plan.archive_name,
            package_metadata_updated: false,
            updated: false,
        });
    };
    let binary_sha256 = prepared
        .binary_sha256
        .ok_or_else(|| "cc_connect_update_prepared_payload_invalid".to_string())?;

    let package_snapshot = npm_package_snapshot(&prepared.executable)?;
    let trusted_release = CcConnectTrustedRelease {
        version: prepared.plan.version.to_string(),
        sha256: binary_sha256.clone(),
        asset_name: prepared.plan.archive_name.clone(),
        release_url: prepared.plan.html_url.clone(),
        verified_at_ms: super::now_millis(),
    };
    let package_metadata_updated = replace_binary_transactionally(
        &prepared.executable,
        &binary,
        &prepared.plan.version,
        package_snapshot.as_ref(),
        trusted_release,
    )?;

    Ok(CcConnectUpdateResult {
        channel: prepared.channel,
        previous_version: prepared.previous_version.map(|version| version.to_string()),
        installed_version: prepared.plan.version.to_string(),
        executable_path: super::user_path_string(&prepared.executable),
        sha256: binary_sha256,
        release_url: prepared.plan.html_url,
        asset_name: prepared.plan.archive_name,
        package_metadata_updated,
        updated: true,
    })
}

fn trusted_installed_version(sha256: &str) -> Option<Version> {
    super::trusted_binary_version(sha256).and_then(|version| parse_semver(&version))
}

fn compatible_version(version: &Version) -> bool {
    version >= &Version::new(1, 4, 1) && version < &Version::new(2, 0, 0)
}

fn parse_semver(raw: &str) -> Option<Version> {
    let value = raw.trim().trim_start_matches(['v', 'V']);
    Version::parse(value).ok()
}

fn parse_semver_result(raw: &str) -> Result<Version, String> {
    let version =
        parse_semver(raw).ok_or_else(|| "cc_connect_update_version_invalid".to_string())?;
    if !compatible_version(&version) {
        return Err("cc_connect_update_version_incompatible".to_string());
    }
    Ok(version)
}

fn parse_semver_any_result(raw: &str) -> Result<Version, String> {
    parse_semver(raw).ok_or_else(|| "cc_connect_update_version_invalid".to_string())
}

fn update_check_from_plan(
    channel: CcConnectUpdateChannel,
    current: Option<&Version>,
    plan: &ReleasePlan,
    checksum_sha256: String,
) -> CcConnectUpdateCheck {
    CcConnectUpdateCheck {
        channel,
        current_version: current.map(ToString::to_string),
        latest_version: plan.version.to_string(),
        update_available: current.map_or(true, |version| plan.version.gt(version)),
        prerelease: plan.prerelease,
        release_url: plan.html_url.clone(),
        published_at: plan.published_at.clone(),
        asset_name: plan.archive_name.clone(),
        download_size: plan.archive.size,
        checksum_sha256,
    }
}

fn release_client(proxy_enabled: bool, proxy_url: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent(format!(
            "CLI-Manager/{} cc-connect-updater",
            env!("CARGO_PKG_VERSION")
        ))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.stop();
            }
            if validate_github_url(attempt.url()).is_ok() {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }));
    if !proxy_enabled {
        builder = builder.no_proxy();
    } else if let Some(proxy) =
        super::resolve_proxy_url_if_enabled(true, proxy_url, &super::LOCAL_PROXY_PORTS)?
    {
        let proxy = reqwest::Proxy::all(&proxy.url)
            .map_err(|error| format!("cc_connect_update_proxy_invalid:{error}"))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|error| format!("cc_connect_update_client_failed:{error}"))
}

async fn fetch_release_plan(
    client: &Client,
    channel: CcConnectUpdateChannel,
) -> Result<ReleasePlan, String> {
    let url = Url::parse(RELEASES_API_URL)
        .map_err(|_| "cc_connect_update_release_api_invalid".to_string())?;
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("cc_connect_update_check_failed:{error}"))?;
    let bytes = read_bounded(response, MAX_RELEASES_RESPONSE_BYTES).await?;
    let releases: Vec<GithubRelease> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("cc_connect_update_release_json_invalid:{error}"))?;
    select_release(releases, channel)
}

async fn fetch_binary_checksum(client: &Client, plan: &ReleasePlan) -> Result<String, String> {
    let bytes = download_asset(client, &plan.checksums, MAX_CHECKSUMS_BYTES).await?;
    verify_api_digest(&plan.checksums, &bytes)?;
    let checksums = parse_checksums(&bytes)?;
    named_checksum(&checksums, &plan.binary_name).cloned()
}

fn select_release(
    releases: Vec<GithubRelease>,
    channel: CcConnectUpdateChannel,
) -> Result<ReleasePlan, String> {
    let spec = platform_asset_spec()?;
    let mut plans = Vec::new();
    for release in releases {
        if let Some(plan) = release_plan(release, channel, &spec)? {
            plans.push(plan);
        }
    }
    plans
        .into_iter()
        .max_by(|left, right| left.version.cmp(&right.version))
        .ok_or_else(|| "cc_connect_update_compatible_release_missing".to_string())
}

fn release_plan(
    release: GithubRelease,
    channel: CcConnectUpdateChannel,
    spec: &PlatformAssetSpec,
) -> Result<Option<ReleasePlan>, String> {
    if release.draft || (channel == CcConnectUpdateChannel::Stable && release.prerelease) {
        return Ok(None);
    }
    let Some(version) = parse_semver(&release.tag_name) else {
        return Ok(None);
    };
    if !compatible_version(&version) {
        return Ok(None);
    }
    let archive_name = format!(
        "cc-connect-{}-{}-{}{}",
        release.tag_name, spec.os, spec.arch, spec.archive_suffix
    );
    let binary_name = format!(
        "cc-connect-{}-{}-{}{}",
        release.tag_name, spec.os, spec.arch, spec.binary_suffix
    );
    let Some(archive) = release
        .assets
        .iter()
        .find(|asset| asset.name == archive_name)
        .cloned()
    else {
        return Ok(None);
    };
    let Some(checksums) = release
        .assets
        .iter()
        .find(|asset| asset.name == "checksums.txt")
        .cloned()
    else {
        return Ok(None);
    };
    validate_release_page_url(&release.html_url, &release.tag_name)?;
    validate_release_asset(&archive, &release.tag_name, MAX_ARCHIVE_BYTES)?;
    validate_release_asset(&checksums, &release.tag_name, MAX_CHECKSUMS_BYTES)?;
    Ok(Some(ReleasePlan {
        version,
        html_url: release.html_url,
        prerelease: release.prerelease,
        published_at: release.published_at,
        archive,
        checksums,
        archive_name,
        binary_name,
    }))
}

#[derive(Debug)]
struct PlatformAssetSpec {
    os: &'static str,
    arch: &'static str,
    archive_suffix: &'static str,
    binary_suffix: &'static str,
}

fn platform_asset_spec() -> Result<PlatformAssetSpec, String> {
    #[cfg(target_os = "windows")]
    let (os, archive_suffix, binary_suffix) = ("windows", ".zip", ".exe");
    #[cfg(target_os = "macos")]
    let (os, archive_suffix, binary_suffix) = ("darwin", ".tar.gz", "");
    #[cfg(target_os = "linux")]
    let (os, archive_suffix, binary_suffix) = ("linux", ".tar.gz", "");
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err("cc_connect_update_platform_unsupported".to_string());

    #[cfg(target_arch = "x86_64")]
    let arch = "amd64";
    #[cfg(target_arch = "aarch64")]
    let arch = "arm64";
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return Err("cc_connect_update_arch_unsupported".to_string());

    Ok(PlatformAssetSpec {
        os,
        arch,
        archive_suffix,
        binary_suffix,
    })
}

fn validate_github_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("cc_connect_update_url_forbidden".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "cc_connect_update_url_forbidden".to_string())?;
    if !matches!(host, "api.github.com" | "github.com") && !host.ends_with(".githubusercontent.com")
    {
        return Err("cc_connect_update_url_forbidden".to_string());
    }
    Ok(())
}

fn validate_release_page_url(raw: &str, tag: &str) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|_| "cc_connect_update_release_url_invalid".to_string())?;
    validate_github_url(&url)?;
    if url.host_str() != Some("github.com")
        || url.query().is_some()
        || url.path() != format!("/chenhg5/cc-connect/releases/tag/{tag}")
    {
        return Err("cc_connect_update_release_url_invalid".to_string());
    }
    Ok(())
}

fn validate_release_asset(asset: &GithubAsset, tag: &str, limit: usize) -> Result<(), String> {
    if asset.size == 0 || asset.size > limit as u64 {
        return Err("cc_connect_update_asset_size_invalid".to_string());
    }
    let url = Url::parse(&asset.browser_download_url)
        .map_err(|_| "cc_connect_update_asset_url_invalid".to_string())?;
    validate_github_url(&url)?;
    let expected_path = format!("{RELEASE_DOWNLOAD_PATH_PREFIX}{tag}/{}", asset.name);
    if url.host_str() != Some("github.com") || url.path() != expected_path || url.query().is_some()
    {
        return Err("cc_connect_update_asset_url_invalid".to_string());
    }
    if let Some(digest) = asset.digest.as_deref() {
        parse_sha256_digest(digest)?;
    }
    Ok(())
}

async fn download_asset(
    client: &Client,
    asset: &GithubAsset,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|error| format!("cc_connect_update_download_failed:{error}"))?;
    read_bounded(response, limit).await
}

async fn read_bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    validate_github_url(response.url())?;
    if !response.status().is_success() {
        return Err(format!(
            "cc_connect_update_http_status:{}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("cc_connect_update_download_too_large".to_string());
    }
    let mut output = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("cc_connect_update_download_failed:{error}"))?
    {
        if output.len().saturating_add(chunk.len()) > limit {
            return Err("cc_connect_update_download_too_large".to_string());
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn parse_sha256_digest(raw: &str) -> Result<String, String> {
    let digest = raw
        .strip_prefix("sha256:")
        .unwrap_or(raw)
        .trim()
        .to_ascii_lowercase();
    if digest.len() != 64 || !digest.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("cc_connect_update_checksum_invalid".to_string());
    }
    Ok(digest)
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verify_api_digest(asset: &GithubAsset, bytes: &[u8]) -> Result<(), String> {
    let Some(expected) = asset.digest.as_deref() else {
        return Ok(());
    };
    if parse_sha256_digest(expected)? != sha256_bytes(bytes) {
        return Err(format!(
            "cc_connect_update_api_digest_mismatch:{}",
            asset.name
        ));
    }
    Ok(())
}

fn parse_checksums(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "cc_connect_update_checksums_invalid".to_string())?;
    let mut parsed = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let mut fields = line.split_whitespace();
        let hash = fields
            .next()
            .ok_or_else(|| "cc_connect_update_checksums_invalid".to_string())?;
        let name = fields
            .next()
            .ok_or_else(|| "cc_connect_update_checksums_invalid".to_string())?
            .trim_start_matches('*');
        if fields.next().is_some()
            || hash.len() != 64
            || !hash.bytes().all(|value| value.is_ascii_hexdigit())
            || name.is_empty()
            || name.contains(['/', '\\'])
        {
            return Err("cc_connect_update_checksums_invalid".to_string());
        }
        if parsed.iter().any(|(_, existing)| existing == name) {
            return Err("cc_connect_update_checksum_duplicate".to_string());
        }
        parsed.push((hash.to_ascii_lowercase(), name.to_string()));
    }
    if parsed.is_empty() {
        return Err("cc_connect_update_checksums_invalid".to_string());
    }
    Ok(parsed)
}

fn verify_named_checksum(
    checksums: &[(String, String)],
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let expected = named_checksum(checksums, name)?;
    if expected != &sha256_bytes(bytes) {
        return Err(format!("cc_connect_update_checksum_mismatch:{name}"));
    }
    Ok(())
}

fn named_checksum<'a>(checksums: &'a [(String, String)], name: &str) -> Result<&'a String, String> {
    checksums
        .iter()
        .find_map(|(hash, candidate)| (candidate == name).then_some(hash))
        .ok_or_else(|| format!("cc_connect_update_checksum_missing:{name}"))
}

#[cfg(target_os = "windows")]
fn extract_release_binary(
    archive: &[u8],
    _archive_name: &str,
    binary_name: &str,
    _target_parent: &Path,
) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|error| format!("cc_connect_update_archive_invalid:{error}"))?;
    let mut matching_entries = 0usize;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("cc_connect_update_archive_invalid:{error}"))?;
        if entry.name() == binary_name {
            matching_entries += 1;
        }
    }
    if matching_entries != 1 {
        return Err("cc_connect_update_archive_binary_ambiguous".to_string());
    }
    let entry = archive
        .by_name(binary_name)
        .map_err(|_| "cc_connect_update_archive_binary_missing".to_string())?;
    if entry.is_dir() || entry.size() == 0 || entry.size() > MAX_BINARY_BYTES as u64 {
        return Err("cc_connect_update_binary_size_invalid".to_string());
    }
    let mut binary = Vec::with_capacity(entry.size() as usize);
    entry
        .take(MAX_BINARY_BYTES as u64 + 1)
        .read_to_end(&mut binary)
        .map_err(|error| format!("cc_connect_update_archive_read_failed:{error}"))?;
    if binary.is_empty() || binary.len() > MAX_BINARY_BYTES {
        return Err("cc_connect_update_binary_size_invalid".to_string());
    }
    Ok(binary)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn extract_release_binary(
    archive: &[u8],
    archive_name: &str,
    binary_name: &str,
    target_parent: &Path,
) -> Result<Vec<u8>, String> {
    let token = unique_file_token();
    let work_dir = target_parent.join(format!(".cc-connect-extract-{token}"));
    fs::create_dir(&work_dir)
        .map_err(|error| format!("cc_connect_update_extract_dir_failed:{error}"))?;
    let archive_path = work_dir.join(archive_name);
    let result = (|| {
        write_new_synced_file(&archive_path, archive)?;
        let mut command = super::silent_command("tar");
        command
            .args(["-xzf"])
            .arg(&archive_path)
            .arg("-C")
            .arg(&work_dir)
            .arg("--")
            .arg(binary_name);
        let output = super::output_with_timeout(command, Duration::from_secs(30))
            .map_err(|error| format!("cc_connect_update_extract_failed:{error}"))?;
        if !output.status.success() {
            return Err(format!(
                "cc_connect_update_extract_failed:{}",
                super::output_text(&output.stdout, &output.stderr)
            ));
        }
        let binary_path = work_dir.join(binary_name);
        let metadata = fs::symlink_metadata(&binary_path)
            .map_err(|error| format!("cc_connect_update_binary_metadata_failed:{error}"))?;
        if !metadata.file_type().is_file()
            || metadata.len() == 0
            || metadata.len() > MAX_BINARY_BYTES as u64
        {
            return Err("cc_connect_update_binary_size_invalid".to_string());
        }
        read_bounded_file(&binary_path, MAX_BINARY_BYTES, "binary")
    })();
    let _ = fs::remove_dir_all(&work_dir);
    result
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn extract_release_binary(
    _archive: &[u8],
    _archive_name: &str,
    _binary_name: &str,
    _target_parent: &Path,
) -> Result<Vec<u8>, String> {
    Err("cc_connect_update_platform_unsupported".to_string())
}

fn validate_update_target(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() || !path.is_file() {
        return Err("cc_connect_update_target_invalid".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("cc_connect_update_target_invalid:{error}"))?;
    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "cc_connect_update_target_invalid".to_string())?;
    #[cfg(target_os = "windows")]
    let valid_name = file_name.eq_ignore_ascii_case("cc-connect.exe");
    #[cfg(not(target_os = "windows"))]
    let valid_name = file_name == "cc-connect";
    if !valid_name {
        return Err("cc_connect_update_target_invalid".to_string());
    }
    Ok(canonical)
}

fn replace_binary_transactionally(
    target: &Path,
    binary: &[u8],
    expected_version: &Version,
    package_snapshot: Option<&NpmPackageSnapshot>,
    trusted_release: CcConnectTrustedRelease,
) -> Result<bool, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "cc_connect_update_target_parent_missing".to_string())?;
    let token = unique_file_token();
    let staged = parent.join(format!(".cc-connect-update-{token}.tmp"));
    let backup = parent.join(format!(".cc-connect-update-{token}.backup"));
    write_new_synced_file(&staged, binary)?;
    #[cfg(unix)]
    if let Err(error) = set_executable_permissions(&staged) {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }
    if let Err(error) = copy_file_synced(target, &backup) {
        let _ = fs::remove_file(&staged);
        return Err(error);
    }

    let replacement = super::replace_file(&staged, target)
        .map_err(|error| format!("cc_connect_update_replace_failed:{error}"));
    if let Err(error) = replacement {
        let _ = fs::remove_file(&staged);
        let _ = fs::remove_file(&backup);
        return Err(error);
    }

    let validation = probe_installed_version(target)
        .and_then(|actual| {
            if &actual != expected_version {
                Err(format!(
                    "cc_connect_update_version_mismatch:expected={expected_version},actual={actual}"
                ))
            } else {
                Ok(())
            }
        })
        .and_then(|()| validate_managed_config(target));
    if let Err(error) = validation {
        return Err(rollback_binary(target, &backup, package_snapshot, error));
    }
    if let Some(snapshot) = package_snapshot {
        if let Err(error) = sync_npm_package_version(snapshot, expected_version) {
            return Err(rollback_binary(target, &backup, package_snapshot, error));
        }
    }
    if let Err(error) = record_trusted_release(trusted_release) {
        return Err(rollback_binary(target, &backup, package_snapshot, error));
    }
    if let Err(error) = fs::remove_file(&backup) {
        log::warn!("cc-connect updater backup cleanup skipped: {error}");
    }
    Ok(package_snapshot.is_some())
}

fn validate_managed_config(executable: &Path) -> Result<(), String> {
    let config = super::config_path()?;
    if !config.is_file() {
        return Ok(());
    }
    let parent = config
        .parent()
        .ok_or_else(|| "cc_connect_update_config_parent_missing".to_string())?;
    let temporary = parent.join(format!(
        ".cc-connect-update-config-{}.toml",
        unique_file_token()
    ));
    let payload = read_bounded_file(&config, MAX_CONFIG_BYTES, "config")?;
    write_new_synced_file(&temporary, &payload)?;
    let result = super::format_and_check_config_syntax(executable, &temporary);
    let _ = fs::remove_file(&temporary);
    result.map_err(|error| format!("cc_connect_update_config_check_failed:{error}"))
}

fn rollback_binary(
    target: &Path,
    backup: &Path,
    package_snapshot: Option<&NpmPackageSnapshot>,
    cause: String,
) -> String {
    let mut rollback_errors = Vec::new();
    if let Err(error) = super::replace_file(backup, target) {
        rollback_errors.push(format!("binary:{error}"));
    }
    if let Some(snapshot) = package_snapshot {
        if let Err(error) = super::write_file_atomically(
            &snapshot.path,
            &snapshot.original,
            "cc-connect npm package metadata rollback",
        ) {
            rollback_errors.push(format!("package:{error}"));
        }
    }
    if rollback_errors.is_empty() {
        cause
    } else {
        format!(
            "{cause}; cc_connect_update_rollback_failed:{}",
            rollback_errors.join(",")
        )
    }
}

fn probe_installed_version(path: &Path) -> Result<Version, String> {
    let mut command = super::silent_command(&super::path_string(path));
    command.arg("--version");
    let output = super::output_with_timeout(command, VERSION_PROBE_TIMEOUT)
        .map_err(|error| format!("cc_connect_update_version_probe_failed:{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "cc_connect_update_version_probe_failed:{}",
            super::output_text(&output.stdout, &output.stderr)
        ));
    }
    parse_version_output(&super::output_text(&output.stdout, &output.stderr))
}

fn parse_version_output(output: &str) -> Result<Version, String> {
    output
        .split_whitespace()
        .filter_map(|token| {
            let token = token
                .trim_matches(|value: char| matches!(value, '(' | ')' | '[' | ']' | ',' | ';'))
                .trim_start_matches(['v', 'V']);
            Version::parse(token).ok()
        })
        .find(compatible_version)
        .ok_or_else(|| "cc_connect_update_version_probe_invalid".to_string())
}

fn npm_package_snapshot(executable: &Path) -> Result<Option<NpmPackageSnapshot>, String> {
    let Some(bin_dir) = executable.parent() else {
        return Ok(None);
    };
    if bin_dir.file_name().and_then(|value| value.to_str()) != Some("bin") {
        return Ok(None);
    }
    let Some(package_root) = bin_dir.parent() else {
        return Ok(None);
    };
    let path = package_root.join("package.json");
    if !path.is_file() {
        return Ok(None);
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("cc_connect_update_package_metadata_failed:{error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_PACKAGE_JSON_BYTES {
        return Err("cc_connect_update_package_metadata_invalid".to_string());
    }
    let original = read_bounded_file(&path, MAX_PACKAGE_JSON_BYTES as usize, "package")?;
    let value: serde_json::Value = serde_json::from_slice(&original)
        .map_err(|error| format!("cc_connect_update_package_json_invalid:{error}"))?;
    if value.get("name").and_then(serde_json::Value::as_str) != Some("cc-connect") {
        return Ok(None);
    }
    Ok(Some(NpmPackageSnapshot { path, original }))
}

fn sync_npm_package_version(
    snapshot: &NpmPackageSnapshot,
    version: &Version,
) -> Result<(), String> {
    let mut value: serde_json::Value = serde_json::from_slice(&snapshot.original)
        .map_err(|error| format!("cc_connect_update_package_json_invalid:{error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "cc_connect_update_package_json_invalid".to_string())?;
    object.insert(
        "version".to_string(),
        serde_json::Value::String(version.to_string()),
    );
    let mut payload = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("cc_connect_update_package_json_invalid:{error}"))?;
    payload.push(b'\n');
    super::write_file_atomically(&snapshot.path, &payload, "cc-connect npm package metadata")
}

fn trust_store_path() -> Result<PathBuf, String> {
    Ok(super::remote_manager_dir()?.join(TRUST_STORE_FILE_NAME))
}

fn read_trust_store(path: &Path) -> Result<TrustedReleaseStore, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TrustedReleaseStore {
                schema_version: TRUST_STORE_SCHEMA_VERSION,
                releases: Vec::new(),
            });
        }
        Err(error) => return Err(format!("cc_connect_update_trust_store_read_failed:{error}")),
    };
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_TRUST_STORE_BYTES {
        return Err("cc_connect_update_trust_store_invalid".to_string());
    }
    let bytes = read_bounded_file(path, MAX_TRUST_STORE_BYTES as usize, "trust_store")?;
    let store: TrustedReleaseStore = serde_json::from_slice(&bytes)
        .map_err(|error| format!("cc_connect_update_trust_store_invalid:{error}"))?;
    validate_trust_store(&store)?;
    Ok(store)
}

fn validate_trust_store(store: &TrustedReleaseStore) -> Result<(), String> {
    if store.schema_version != TRUST_STORE_SCHEMA_VERSION
        || store.releases.len() > MAX_TRUSTED_RELEASES
    {
        return Err("cc_connect_update_trust_store_invalid".to_string());
    }
    for release in &store.releases {
        let version = parse_semver_result(&release.version)?;
        if release.version != version.to_string()
            || parse_sha256_digest(&release.sha256)? != release.sha256.to_ascii_lowercase()
            || release.asset_name.is_empty()
            || release.asset_name.contains(['/', '\\'])
        {
            return Err("cc_connect_update_trust_store_invalid".to_string());
        }
        let url = Url::parse(&release.release_url)
            .map_err(|_| "cc_connect_update_trust_store_invalid".to_string())?;
        validate_github_url(&url)?;
        if url.host_str() != Some("github.com") {
            return Err("cc_connect_update_trust_store_invalid".to_string());
        }
    }
    Ok(())
}

fn trusted_version_for_sha256_at(path: &Path, sha256: &str) -> Result<Option<String>, String> {
    let sha256 = parse_sha256_digest(sha256)?;
    let store = read_trust_store(path)?;
    Ok(store
        .releases
        .iter()
        .rev()
        .find(|release| release.sha256.eq_ignore_ascii_case(&sha256))
        .map(|release| release.version.clone()))
}

fn record_trusted_release(release: CcConnectTrustedRelease) -> Result<(), String> {
    let path = trust_store_path()?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| "cc_connect_update_trust_store_parent_missing".to_string())?,
    )
    .map_err(|error| format!("cc_connect_update_trust_store_create_failed:{error}"))?;
    record_trusted_release_at(&path, release)
}

fn record_trusted_release_at(
    path: &Path,
    mut release: CcConnectTrustedRelease,
) -> Result<(), String> {
    release.version = parse_semver_result(&release.version)?.to_string();
    release.sha256 = parse_sha256_digest(&release.sha256)?;
    let release_url = Url::parse(&release.release_url)
        .map_err(|_| "cc_connect_update_release_url_invalid".to_string())?;
    validate_github_url(&release_url)?;
    if release_url.host_str() != Some("github.com")
        || release.asset_name.is_empty()
        || release.asset_name.contains(['/', '\\'])
    {
        return Err("cc_connect_update_trust_store_invalid".to_string());
    }
    let mut store = read_trust_store(path)?;
    store
        .releases
        .retain(|entry| entry.sha256 != release.sha256 && entry.version != release.version);
    store.releases.push(release);
    if store.releases.len() > MAX_TRUSTED_RELEASES {
        store
            .releases
            .drain(..store.releases.len() - MAX_TRUSTED_RELEASES);
    }
    store.schema_version = TRUST_STORE_SCHEMA_VERSION;
    let mut payload = serde_json::to_vec_pretty(&store)
        .map_err(|error| format!("cc_connect_update_trust_store_invalid:{error}"))?;
    payload.push(b'\n');
    super::write_file_atomically(path, &payload, "cc-connect trusted release store")
}

fn unique_file_token() -> String {
    format!("{}-{}", std::process::id(), super::now_millis())
}

fn write_new_synced_file(path: &Path, payload: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("cc_connect_update_stage_create_failed:{error}"))?;
    let result = (|| {
        file.write_all(payload)
            .map_err(|error| format!("cc_connect_update_stage_write_failed:{error}"))?;
        file.sync_all()
            .map_err(|error| format!("cc_connect_update_stage_sync_failed:{error}"))
    })();
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

fn copy_file_synced(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = File::open(source)
        .map_err(|error| format!("cc_connect_update_backup_open_failed:{error}"))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("cc_connect_update_backup_create_failed:{error}"))?;
    let result = (|| {
        std::io::copy(&mut input, &mut output)
            .map_err(|error| format!("cc_connect_update_backup_write_failed:{error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("cc_connect_update_backup_sync_failed:{error}"))
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

#[cfg(unix)]
fn set_executable_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("cc_connect_update_permissions_failed:{error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("cc_connect_update_permissions_failed:{error}"))
}

fn read_bounded_file(path: &Path, limit: usize, label: &str) -> Result<Vec<u8>, String> {
    let file = File::open(path)
        .map_err(|error| format!("cc_connect_update_{label}_read_failed:{error}"))?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cc_connect_update_{label}_read_failed:{error}"))?;
    if bytes.is_empty() || bytes.len() > limit {
        return Err(format!("cc_connect_update_{label}_size_invalid"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(tag: &str, name: &str, size: u64) -> GithubAsset {
        GithubAsset {
            name: name.to_string(),
            browser_download_url: format!(
                "https://github.com/chenhg5/cc-connect/releases/download/{tag}/{name}"
            ),
            size,
            digest: None,
        }
    }

    #[test]
    fn compatibility_accepts_supported_stable_and_prerelease_versions() {
        assert!(is_compatible_version("1.4.1"));
        assert!(is_compatible_version("v1.5.0-beta.2"));
        assert!(!is_compatible_version("1.4.0"));
        assert!(!is_compatible_version("2.0.0"));
        assert!(!is_compatible_version("not-a-version"));
    }

    #[test]
    fn checksums_require_unique_safe_file_names() {
        let bytes =
            b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  cc-connect.exe\n";
        let parsed = parse_checksums(bytes).unwrap();
        assert_eq!(parsed[0].1, "cc-connect.exe");
        assert!(parse_checksums(b"abcd  ../cc-connect.exe\n").is_err());
        let duplicate = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  cc-connect.exe\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  cc-connect.exe\n";
        assert!(parse_checksums(duplicate).is_err());
    }

    #[test]
    fn release_selection_respects_channel_and_semver() {
        let spec = platform_asset_spec().unwrap();
        let release = |tag: &str, prerelease: bool| {
            let archive_name = format!(
                "cc-connect-{tag}-{}-{}{}",
                spec.os, spec.arch, spec.archive_suffix
            );
            GithubRelease {
                tag_name: tag.to_string(),
                html_url: format!("https://github.com/chenhg5/cc-connect/releases/tag/{tag}"),
                draft: false,
                prerelease,
                published_at: None,
                assets: vec![
                    asset(tag, &archive_name, 100),
                    asset(tag, "checksums.txt", 100),
                ],
            }
        };
        let releases = vec![release("v1.4.1", false), release("v1.5.0-beta.2", true)];
        let stable = select_release(releases.clone(), CcConnectUpdateChannel::Stable).unwrap();
        assert_eq!(stable.version, Version::new(1, 4, 1));
        let preview = select_release(releases, CcConnectUpdateChannel::Prerelease).unwrap();
        assert_eq!(preview.version, Version::parse("1.5.0-beta.2").unwrap());
    }

    #[test]
    fn trust_store_round_trip_is_bounded_and_normalized() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("trust.json");
        let hash = "A".repeat(64);
        record_trusted_release_at(
            &path,
            CcConnectTrustedRelease {
                version: "v1.5.0-beta.2".to_string(),
                sha256: hash.clone(),
                asset_name: "cc-connect-v1.5.0-beta.2-windows-amd64.zip".to_string(),
                release_url: "https://github.com/chenhg5/cc-connect/releases/tag/v1.5.0-beta.2"
                    .to_string(),
                verified_at_ms: 1,
            },
        )
        .unwrap();
        assert_eq!(
            trusted_version_for_sha256_at(&path, &hash).unwrap(),
            Some("1.5.0-beta.2".to_string())
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn zip_extraction_reads_only_the_expected_binary() {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                "cc-connect-v1.5.0-beta.2-windows-amd64.exe",
                zip::write::FileOptions::default(),
            )
            .unwrap();
        archive.write_all(b"verified binary").unwrap();
        archive
            .start_file("ignored.txt", zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(b"ignored").unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        let extracted = extract_release_binary(
            &bytes,
            "archive.zip",
            "cc-connect-v1.5.0-beta.2-windows-amd64.exe",
            Path::new("."),
        )
        .unwrap();
        assert_eq!(extracted, b"verified binary");
    }

    #[test]
    fn version_probe_parser_preserves_prerelease() {
        assert_eq!(
            parse_version_output("cc-connect v1.5.0-beta.2 (commit abc)").unwrap(),
            Version::parse("1.5.0-beta.2").unwrap()
        );
    }
}
