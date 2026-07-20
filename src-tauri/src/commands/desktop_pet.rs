use crate::app_paths;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime};
use uuid::Uuid;
use zip::ZipArchive;

const PET_SCHEMA_VERSION: u32 = 1;
const PET_WINDOW_LABEL: &str = "desktop-pet";
const PET_WINDOW_BASE_WIDTH: f64 = 190.0;
const PET_WINDOW_BASE_HEIGHT: f64 = 210.0;
const PET_WINDOW_MARGIN: i32 = 24;
const MAX_CATALOG_ITEMS: usize = 200;
const MAX_ARCHIVE_BYTES: usize = 25 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 30 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 40;
const MAX_CODEX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_CODEX_SPRITESHEET_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_ASSET_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SVG_ASSET_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RASTER_DIMENSION: u32 = 4096;
const MAX_RASTER_PIXELS: u64 = 16 * 1024 * 1024;
const CODEX_PET_ENGINE: &str = "codex-sprite";
const CODEX_PET_ID_PREFIX: &str = "codex.";
const CODEX_SPRITE_CELL_WIDTH: u32 = 192;
const CODEX_SPRITE_CELL_HEIGHT: u32 = 208;
const CODEX_SPRITE_COLUMNS: u32 = 8;
const CODEX_V1_ROWS: u32 = 9;
const CODEX_V2_ROWS: u32 = 11;
const CATALOG_CACHE_MAX_AGE: Duration = Duration::from_secs(6 * 60 * 60);
const REMOTE_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/GAMPA228/CLI-Manager/master/public/pet-catalog/catalog.json";
const EMBEDDED_CATALOG: &str = include_str!("../../../public/pet-catalog/catalog.json");
const TERMINAL_ROBOT_PACK: &[u8] =
    include_bytes!("../../../public/pet-catalog/packages/terminal-robot-1.0.0.clipet");
const PIXEL_FOX_PACK: &[u8] =
    include_bytes!("../../../public/pet-catalog/packages/pixel-fox-1.0.0.clipet");
const MINT_SLIME_PACK: &[u8] =
    include_bytes!("../../../public/pet-catalog/packages/mint-slime-1.0.0.clipet");
const TERMINAL_ROBOT_PREVIEW: &str =
    include_str!("../../../public/pet-catalog/previews/terminal-robot.svg");
const PIXEL_FOX_PREVIEW: &str = include_str!("../../../public/pet-catalog/previews/pixel-fox.svg");
const MINT_SLIME_PREVIEW: &str =
    include_str!("../../../public/pet-catalog/previews/mint-slime.svg");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedText {
    #[serde(rename = "zh-CN")]
    pub zh_cn: String,
    #[serde(rename = "en-US")]
    pub en_us: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCanvas {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetStateAsset {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetManifest {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub name: LocalizedText,
    pub description: LocalizedText,
    pub author: String,
    pub license: String,
    pub engine: String,
    pub canvas: PetCanvas,
    pub states: BTreeMap<String, PetStateAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sprite_version_number: Option<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPetManifest {
    id: String,
    display_name: String,
    #[serde(default)]
    description: String,
    spritesheet_path: String,
    #[serde(default)]
    sprite_version_number: Option<u32>,
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCatalogEntry {
    pub id: String,
    pub version: String,
    pub name: LocalizedText,
    pub description: LocalizedText,
    pub author: String,
    pub license: String,
    pub min_app_version: String,
    pub preview_url: String,
    #[serde(default)]
    pub preview_data_url: Option<String>,
    pub download_url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetCatalog {
    schema_version: u32,
    updated_at: String,
    items: Vec<PetCatalogEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCatalogResponse {
    pub items: Vec<PetCatalogEntry>,
    pub source: String,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPet {
    pub manifest: PetManifest,
    pub base_dir: String,
    pub source: String,
    pub format: String,
    pub removable: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetWindowConfig {
    pub enabled: bool,
    pub always_on_top: bool,
    pub scale: f64,
    pub position: Option<PetPosition>,
}

fn pets_root() -> Result<PathBuf, String> {
    app_paths::pets_dir()
}

fn codex_pets_root() -> Result<PathBuf, String> {
    app_paths::codex_pets_dir()
}

fn installed_root(root: &Path) -> PathBuf {
    root.join("installed")
}

fn temp_root(root: &Path) -> PathBuf {
    root.join("temp")
}

fn cache_path(root: &Path) -> PathBuf {
    root.join("catalog-cache.json")
}

fn ensure_pet_dirs(root: &Path) -> Result<(), String> {
    for path in [root.to_path_buf(), installed_root(root), temp_root(root)] {
        fs::create_dir_all(&path).map_err(|err| format!("pet_dir_create_failed: {err}"))?;
    }
    Ok(())
}

fn valid_pet_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 80
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
}

fn valid_codex_pet_id(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.len() > 72 || value.starts_with('-') || value.ends_with('-') {
        return false;
    }
    let mut previous_hyphen = false;
    for byte in value.bytes() {
        if byte == b'-' {
            if previous_hyphen {
                return false;
            }
            previous_hyphen = true;
        } else if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            previous_hyphen = false;
        } else {
            return false;
        }
    }
    true
}

fn internal_codex_pet_id(value: &str) -> String {
    format!("{CODEX_PET_ID_PREFIX}{value}")
}

fn raw_codex_pet_id(value: &str) -> Option<&str> {
    value
        .strip_prefix(CODEX_PET_ID_PREFIX)
        .filter(|raw| valid_codex_pet_id(raw))
}

fn safe_relative_file(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.len() > 180 || value.contains('\\') {
        return None;
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return None;
    }
    let mut has_normal = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_normal = true,
            _ => return None,
        }
    }
    has_normal.then(|| path.to_path_buf())
}

fn allowed_asset_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "png" | "webp" | "svg"))
        .unwrap_or(false)
}

fn validate_svg(text: &str) -> Result<(), String> {
    let lowered = text.to_ascii_lowercase();
    let forbidden = [
        "<script",
        "<foreignobject",
        "<iframe",
        "<object",
        "<embed",
        "javascript:",
        "data:text/html",
        "onload=",
        "onclick=",
        "onerror=",
        "url(http",
        "href=\"http",
        "href='http",
        "xlink:href=\"http",
        "xlink:href='http",
    ];
    if forbidden.iter().any(|needle| lowered.contains(needle)) {
        return Err("pet_svg_unsafe_content".to_string());
    }
    if !lowered.contains("<svg") {
        return Err("pet_svg_invalid".to_string());
    }
    Ok(())
}

fn read_u24_le(bytes: &[u8]) -> u32 {
    bytes[0] as u32 | ((bytes[1] as u32) << 8) | ((bytes[2] as u32) << 16)
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 20 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let mut offset = 12usize;
    while offset.checked_add(8)? <= bytes.len() {
        let tag = &bytes[offset..offset + 4];
        let chunk_size =
            u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let data_start = offset.checked_add(8)?;
        let data_end = data_start.checked_add(chunk_size)?;
        if data_end > bytes.len() {
            return None;
        }
        let data = &bytes[data_start..data_end];
        match tag {
            b"VP8X" if data.len() >= 10 => {
                return Some((read_u24_le(&data[4..7]) + 1, read_u24_le(&data[7..10]) + 1));
            }
            b"VP8L" if data.len() >= 5 && data[0] == 0x2f => {
                let width = 1 + data[1] as u32 + (((data[2] & 0x3f) as u32) << 8);
                let height = 1
                    + (((data[2] & 0xc0) as u32) >> 6)
                    + ((data[3] as u32) << 2)
                    + (((data[4] & 0x0f) as u32) << 10);
                return Some((width, height));
            }
            b"VP8 " if data.len() >= 10 && data[3..6] == [0x9d, 0x01, 0x2a] => {
                let width = u16::from_le_bytes([data[6], data[7]]) as u32 & 0x3fff;
                let height = u16::from_le_bytes([data[8], data[9]]) as u32 & 0x3fff;
                return Some((width, height));
            }
            _ => {}
        }
        offset = data_end.checked_add(chunk_size % 2)?;
    }
    None
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[0..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}

fn validate_image_asset(path: &Path, extension: &str) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|err| format!("pet_manifest_asset_read_failed: {err}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_ASSET_BYTES {
        return Err("pet_manifest_asset_size_invalid".to_string());
    }
    if extension == "svg" {
        if metadata.len() > MAX_SVG_ASSET_BYTES {
            return Err("pet_manifest_asset_size_invalid".to_string());
        }
        let text = fs::read_to_string(path).map_err(|err| format!("pet_svg_read_failed: {err}"))?;
        return validate_svg(&text);
    }

    let bytes = fs::read(path).map_err(|err| format!("pet_manifest_asset_read_failed: {err}"))?;
    let dimensions = match extension {
        "png" => png_dimensions(&bytes),
        "webp" => webp_dimensions(&bytes),
        _ => None,
    }
    .ok_or_else(|| "pet_manifest_asset_format_invalid".to_string())?;
    let pixels = u64::from(dimensions.0) * u64::from(dimensions.1);
    if dimensions.0 == 0
        || dimensions.1 == 0
        || dimensions.0 > MAX_RASTER_DIMENSION
        || dimensions.1 > MAX_RASTER_DIMENSION
        || pixels > MAX_RASTER_PIXELS
    {
        return Err("pet_manifest_asset_dimensions_invalid".to_string());
    }
    Ok(())
}

fn codex_sprite_dimensions(sprite_version_number: u32) -> Option<(u32, u32)> {
    let rows = match sprite_version_number {
        1 => CODEX_V1_ROWS,
        2 => CODEX_V2_ROWS,
        _ => return None,
    };
    Some((
        CODEX_SPRITE_CELL_WIDTH * CODEX_SPRITE_COLUMNS,
        CODEX_SPRITE_CELL_HEIGHT * rows,
    ))
}

fn codex_state_assets(file: &str) -> BTreeMap<String, PetStateAsset> {
    [
        ("idle", 0, 6),
        ("working", 7, 6),
        ("waiting", 6, 6),
        ("success", 8, 6),
        ("error", 5, 8),
        ("sleeping", 0, 6),
    ]
    .into_iter()
    .map(|(state, row, frames)| {
        (
            state.to_string(),
            PetStateAsset {
                file: file.to_string(),
                row: Some(row),
                frames: Some(frames),
            },
        )
    })
    .collect()
}

fn read_codex_pet(
    pet_dir: &Path,
    expected_raw_id: Option<&str>,
    source: &str,
    removable: bool,
) -> Result<InstalledPet, String> {
    let manifest_path = pet_dir.join("pet.json");
    let manifest_metadata = fs::metadata(&manifest_path)
        .map_err(|err| format!("pet_codex_manifest_read_failed: {err}"))?;
    if !manifest_metadata.is_file()
        || manifest_metadata.len() == 0
        || manifest_metadata.len() > MAX_CODEX_MANIFEST_BYTES
    {
        return Err("pet_codex_manifest_size_invalid".to_string());
    }
    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|err| format!("pet_codex_manifest_read_failed: {err}"))?;
    let codex: CodexPetManifest = serde_json::from_str(&manifest_text)
        .map_err(|err| format!("pet_codex_manifest_parse_failed: {err}"))?;
    let raw_id = codex.id.trim();
    if !valid_codex_pet_id(raw_id)
        || expected_raw_id
            .map(|expected| expected != raw_id)
            .unwrap_or(false)
    {
        return Err("pet_codex_id_invalid".to_string());
    }
    let display_name = codex.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 120 {
        return Err("pet_codex_name_invalid".to_string());
    }
    if codex.description.chars().count() > 1000 {
        return Err("pet_codex_description_invalid".to_string());
    }
    if codex
        .kind
        .as_deref()
        .map(|kind| !matches!(kind, "object" | "animal" | "person" | "creature"))
        .unwrap_or(false)
    {
        return Err("pet_codex_kind_invalid".to_string());
    }
    let sprite_version_number = codex.sprite_version_number.unwrap_or(1);
    let expected_dimensions = codex_sprite_dimensions(sprite_version_number)
        .ok_or_else(|| "pet_codex_sprite_version_unsupported".to_string())?;
    let relative = safe_relative_file(codex.spritesheet_path.trim())
        .ok_or_else(|| "pet_codex_spritesheet_path_invalid".to_string())?;
    if !relative
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("webp"))
        .unwrap_or(false)
    {
        return Err("pet_codex_spritesheet_type_invalid".to_string());
    }
    let spritesheet_path = pet_dir.join(&relative);
    let spritesheet_metadata = fs::metadata(&spritesheet_path)
        .map_err(|err| format!("pet_codex_spritesheet_read_failed: {err}"))?;
    if !spritesheet_metadata.is_file()
        || spritesheet_metadata.len() == 0
        || spritesheet_metadata.len() > MAX_CODEX_SPRITESHEET_BYTES
    {
        return Err("pet_codex_spritesheet_size_invalid".to_string());
    }
    let spritesheet = fs::read(&spritesheet_path)
        .map_err(|err| format!("pet_codex_spritesheet_read_failed: {err}"))?;
    if webp_dimensions(&spritesheet) != Some(expected_dimensions) {
        return Err("pet_codex_spritesheet_dimensions_invalid".to_string());
    }

    let description = codex.description.trim();
    let description = if description.is_empty() {
        display_name
    } else {
        description
    };
    let relative_string = relative.to_string_lossy().replace('\\', "/");
    Ok(InstalledPet {
        manifest: PetManifest {
            schema_version: PET_SCHEMA_VERSION,
            id: internal_codex_pet_id(raw_id),
            version: "1.0.0".to_string(),
            name: LocalizedText {
                zh_cn: display_name.to_string(),
                en_us: display_name.to_string(),
            },
            description: LocalizedText {
                zh_cn: description.to_string(),
                en_us: description.to_string(),
            },
            author: "Codex Pets".to_string(),
            license: "Unspecified".to_string(),
            engine: CODEX_PET_ENGINE.to_string(),
            canvas: PetCanvas {
                width: CODEX_SPRITE_CELL_WIDTH,
                height: CODEX_SPRITE_CELL_HEIGHT,
            },
            states: codex_state_assets(&relative_string),
            sprite_version_number: Some(sprite_version_number),
        },
        base_dir: path_string(pet_dir),
        source: source.to_string(),
        format: "codex".to_string(),
        removable,
    })
}

fn validate_manifest(manifest: &PetManifest, base_dir: &Path) -> Result<(), String> {
    if manifest.schema_version != PET_SCHEMA_VERSION {
        return Err("pet_manifest_schema_unsupported".to_string());
    }
    if !valid_pet_id(&manifest.id) {
        return Err("pet_manifest_id_invalid".to_string());
    }
    Version::parse(&manifest.version).map_err(|_| "pet_manifest_version_invalid".to_string())?;
    if manifest.name.zh_cn.trim().is_empty()
        || manifest.name.en_us.trim().is_empty()
        || manifest.author.trim().is_empty()
        || manifest.license.trim().is_empty()
    {
        return Err("pet_manifest_metadata_invalid".to_string());
    }
    if manifest.engine != "image-v1" {
        return Err("pet_manifest_engine_unsupported".to_string());
    }
    if !(64..=512).contains(&manifest.canvas.width) || !(64..=512).contains(&manifest.canvas.height)
    {
        return Err("pet_manifest_canvas_invalid".to_string());
    }
    if !manifest.states.contains_key("idle") {
        return Err("pet_manifest_idle_missing".to_string());
    }
    let allowed_states = ["idle", "working", "waiting", "success", "error", "sleeping"];
    for (state, asset) in &manifest.states {
        if !allowed_states.contains(&state.as_str()) {
            return Err("pet_manifest_state_invalid".to_string());
        }
        let relative = safe_relative_file(&asset.file)
            .ok_or_else(|| "pet_manifest_asset_path_invalid".to_string())?;
        if !allowed_asset_extension(&relative) {
            return Err("pet_manifest_asset_type_unsupported".to_string());
        }
        let absolute = base_dir.join(&relative);
        let extension = relative
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| "pet_manifest_asset_type_unsupported".to_string())?;
        validate_image_asset(&absolute, &extension)?;
    }
    Ok(())
}

fn validate_catalog(catalog: &PetCatalog) -> Result<(), String> {
    if catalog.schema_version != PET_SCHEMA_VERSION || catalog.items.len() > MAX_CATALOG_ITEMS {
        return Err("pet_catalog_schema_invalid".to_string());
    }
    for item in &catalog.items {
        if !valid_pet_id(&item.id)
            || Version::parse(&item.version).is_err()
            || Version::parse(&item.min_app_version).is_err()
            || item.name.zh_cn.trim().is_empty()
            || item.name.en_us.trim().is_empty()
            || item.author.trim().is_empty()
            || item.license.trim().is_empty()
            || item.size_bytes == 0
            || item.size_bytes as usize > MAX_ARCHIVE_BYTES
            || item.sha256.len() != 64
            || !item.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !item
                .download_url
                .starts_with("https://raw.githubusercontent.com/")
            || !item
                .preview_url
                .starts_with("https://raw.githubusercontent.com/")
        {
            return Err("pet_catalog_entry_invalid".to_string());
        }
    }
    Ok(())
}

fn parse_catalog(text: &str) -> Result<PetCatalog, String> {
    let catalog: PetCatalog =
        serde_json::from_str(text).map_err(|err| format!("pet_catalog_parse_failed: {err}"))?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}

fn preview_data_url(id: &str) -> Option<String> {
    let svg = match id {
        "official.terminal-robot" => TERMINAL_ROBOT_PREVIEW,
        "official.pixel-fox" => PIXEL_FOX_PREVIEW,
        "official.mint-slime" => MINT_SLIME_PREVIEW,
        _ => return None,
    };
    Some(format!(
        "data:image/svg+xml;base64,{}",
        BASE64_STANDARD.encode(svg.as_bytes())
    ))
}

fn enrich_catalog(mut catalog: PetCatalog) -> PetCatalog {
    for item in &mut catalog.items {
        item.preview_data_url = preview_data_url(&item.id);
    }
    catalog
}

fn read_cached_catalog(root: &Path, require_fresh: bool) -> Result<Option<PetCatalog>, String> {
    let path = cache_path(root);
    if !path.is_file() {
        return Ok(None);
    }
    if require_fresh {
        let modified = fs::metadata(&path)
            .and_then(|value| value.modified())
            .map_err(|err| format!("pet_catalog_cache_metadata_failed: {err}"))?;
        let age = SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default();
        if age > CATALOG_CACHE_MAX_AGE {
            return Ok(None);
        }
    }
    let text =
        fs::read_to_string(&path).map_err(|err| format!("pet_catalog_cache_read_failed: {err}"))?;
    parse_catalog(&text).map(Some)
}

fn write_catalog_cache(root: &Path, text: &str) -> Result<(), String> {
    let target = cache_path(root);
    let temp = root.join(format!("catalog-cache.{}.tmp", Uuid::new_v4()));
    let backup = root.join(format!("catalog-cache.{}.backup", Uuid::new_v4()));
    fs::write(&temp, text).map_err(|err| format!("pet_catalog_cache_write_failed: {err}"))?;

    if target.exists() {
        if let Err(err) = fs::rename(&target, &backup) {
            let _ = fs::remove_file(&temp);
            return Err(format!("pet_catalog_cache_backup_failed: {err}"));
        }
    }

    if let Err(err) = fs::rename(&temp, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_file(&temp);
        return Err(format!("pet_catalog_cache_replace_failed: {err}"));
    }
    if backup.exists() {
        if let Err(err) = fs::remove_file(&backup) {
            log::warn!(
                "desktop pet catalog cache backup cleanup skipped {}: {err}",
                backup.display()
            );
        }
    }
    Ok(())
}

async fn fetch_remote_catalog() -> Result<(PetCatalog, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| format!("pet_catalog_client_failed: {err}"))?;
    let response = client
        .get(REMOTE_CATALOG_URL)
        .send()
        .await
        .map_err(|err| format!("pet_catalog_download_failed: {err}"))?
        .error_for_status()
        .map_err(|err| format!("pet_catalog_http_failed: {err}"))?;
    let text = response
        .text()
        .await
        .map_err(|err| format!("pet_catalog_body_failed: {err}"))?;
    let catalog = parse_catalog(&text)?;
    Ok((catalog, text))
}

async fn load_catalog(refresh: bool) -> Result<PetCatalogResponse, String> {
    let root = pets_root()?;
    ensure_pet_dirs(&root)?;
    if !refresh {
        if let Some(catalog) = read_cached_catalog(&root, true)? {
            return Ok(PetCatalogResponse {
                items: enrich_catalog(catalog).items,
                source: "cache".to_string(),
                warning: None,
            });
        }
    }

    match fetch_remote_catalog().await {
        Ok((catalog, text)) => {
            if let Err(err) = write_catalog_cache(&root, &text) {
                log::warn!("desktop pet catalog cache write skipped: {err}");
            }
            Ok(PetCatalogResponse {
                items: enrich_catalog(catalog).items,
                source: "remote".to_string(),
                warning: None,
            })
        }
        Err(remote_err) => {
            if let Some(catalog) = read_cached_catalog(&root, false)? {
                return Ok(PetCatalogResponse {
                    items: enrich_catalog(catalog).items,
                    source: "cache".to_string(),
                    warning: Some(remote_err),
                });
            }
            let catalog = parse_catalog(EMBEDDED_CATALOG)?;
            Ok(PetCatalogResponse {
                items: enrich_catalog(catalog).items,
                source: "bundled".to_string(),
                warning: Some(remote_err),
            })
        }
    }
}

fn embedded_package(id: &str, version: &str) -> Option<&'static [u8]> {
    match (id, version) {
        ("official.terminal-robot", "1.0.0") => Some(TERMINAL_ROBOT_PACK),
        ("official.pixel-fox", "1.0.0") => Some(PIXEL_FOX_PACK),
        ("official.mint-slime", "1.0.0") => Some(MINT_SLIME_PACK),
        _ => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn download_package(entry: &PetCatalogEntry) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| format!("pet_download_client_failed: {err}"))?;
    let response = client
        .get(&entry.download_url)
        .send()
        .await
        .map_err(|err| format!("pet_download_failed: {err}"))?
        .error_for_status()
        .map_err(|err| format!("pet_download_http_failed: {err}"))?;
    if response
        .content_length()
        .map(|size| size as usize > MAX_ARCHIVE_BYTES)
        .unwrap_or(false)
    {
        return Err("pet_download_too_large".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("pet_download_body_failed: {err}"))?;
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("pet_download_too_large".to_string());
    }
    Ok(bytes.to_vec())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn read_installed_pet(version_dir: &Path) -> Result<InstalledPet, String> {
    let manifest_path = version_dir.join("manifest.json");
    let codex_manifest_path = version_dir.join("pet.json");
    if manifest_path.is_file() == codex_manifest_path.is_file() {
        return Err("pet_manifest_ambiguous_or_missing".to_string());
    }
    if codex_manifest_path.is_file() {
        return read_codex_pet(version_dir, None, "cli-manager", true);
    }
    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|err| format!("pet_manifest_read_failed: {err}"))?;
    let manifest: PetManifest = serde_json::from_str(&manifest_text)
        .map_err(|err| format!("pet_manifest_parse_failed: {err}"))?;
    validate_manifest(&manifest, version_dir)?;
    Ok(InstalledPet {
        manifest,
        base_dir: path_string(version_dir),
        source: "cli-manager".to_string(),
        format: "clipet".to_string(),
        removable: true,
    })
}

fn install_package_bytes_to_root(
    root: &Path,
    bytes: &[u8],
    expected_id: Option<&str>,
    expected_version: Option<&str>,
) -> Result<InstalledPet, String> {
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("pet_archive_size_invalid".to_string());
    }
    ensure_pet_dirs(root)?;
    let stage_dir = temp_root(root).join(Uuid::new_v4().to_string());
    fs::create_dir_all(&stage_dir).map_err(|err| format!("pet_stage_create_failed: {err}"))?;
    let extraction_result = (|| -> Result<(), String> {
        let mut archive = ZipArchive::new(Cursor::new(bytes))
            .map_err(|err| format!("pet_archive_open_failed: {err}"))?;
        if archive.len() == 0 || archive.len() > MAX_ARCHIVE_ENTRIES {
            return Err("pet_archive_entries_invalid".to_string());
        }
        let mut total_size = 0u64;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|err| format!("pet_archive_entry_failed: {err}"))?;
            if entry.is_dir() {
                continue;
            }
            if entry
                .unix_mode()
                .map(|mode| mode & 0o170000 == 0o120000)
                .unwrap_or(false)
            {
                return Err("pet_archive_symlink_rejected".to_string());
            }
            total_size = total_size.saturating_add(entry.size());
            if total_size > MAX_EXTRACTED_BYTES {
                return Err("pet_archive_unpacked_too_large".to_string());
            }
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| "pet_archive_path_invalid".to_string())?
                .to_path_buf();
            if enclosed.components().count() > 4 {
                return Err("pet_archive_path_too_deep".to_string());
            }
            let file_name = enclosed
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if !matches!(file_name, "manifest.json" | "pet.json")
                && !allowed_asset_extension(&enclosed)
            {
                return Err("pet_archive_file_type_unsupported".to_string());
            }
            let output_path = stage_dir.join(enclosed);
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("pet_archive_dir_failed: {err}"))?;
            }
            let mut output = fs::File::create(&output_path)
                .map_err(|err| format!("pet_archive_write_failed: {err}"))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|err| format!("pet_archive_extract_failed: {err}"))?;
        }
        Ok(())
    })();
    if let Err(err) = extraction_result {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(err);
    }

    let staged = match read_installed_pet(&stage_dir) {
        Ok(value) => value,
        Err(err) => {
            let _ = fs::remove_dir_all(&stage_dir);
            return Err(err);
        }
    };
    if expected_id
        .map(|value| value != staged.manifest.id)
        .unwrap_or(false)
    {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err("pet_archive_id_mismatch".to_string());
    }
    if expected_version
        .map(|value| value != staged.manifest.version)
        .unwrap_or(false)
    {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err("pet_archive_version_mismatch".to_string());
    }

    let id_dir = installed_root(root).join(&staged.manifest.id);
    fs::create_dir_all(&id_dir).map_err(|err| format!("pet_install_dir_failed: {err}"))?;
    let target_dir = id_dir.join(&staged.manifest.version);
    let backup_dir = id_dir.join(format!(".backup-{}", Uuid::new_v4()));
    if target_dir.exists() {
        fs::rename(&target_dir, &backup_dir)
            .map_err(|err| format!("pet_install_backup_failed: {err}"))?;
    }
    if let Err(err) = fs::rename(&stage_dir, &target_dir) {
        if backup_dir.exists() {
            let _ = fs::rename(&backup_dir, &target_dir);
        }
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(format!("pet_install_commit_failed: {err}"));
    }
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }
    read_installed_pet(&target_dir)
}

fn newest_installed_pet(root: &Path, pet_id: &str) -> Result<Option<InstalledPet>, String> {
    if !valid_pet_id(pet_id) {
        return Err("pet_id_invalid".to_string());
    }
    let id_dir = installed_root(root).join(pet_id);
    if !id_dir.is_dir() {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&id_dir).map_err(|err| format!("pet_list_failed: {err}"))? {
        let entry = entry.map_err(|err| format!("pet_list_entry_failed: {err}"))?;
        if !entry.path().is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        match read_installed_pet(&entry.path()) {
            Ok(pet) if pet.manifest.id == pet_id => {
                if let Ok(version) = Version::parse(&pet.manifest.version) {
                    candidates.push((version, pet));
                }
            }
            Ok(_) => log::warn!(
                "desktop pet directory id mismatch: {}",
                entry.path().display()
            ),
            Err(err) => log::warn!(
                "desktop pet ignored invalid install {}: {err}",
                entry.path().display()
            ),
        }
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(candidates.into_iter().next().map(|(_, pet)| pet))
}

fn list_managed_pets(root: &Path) -> Result<Vec<InstalledPet>, String> {
    let mut pets = Vec::new();
    for id_entry in
        fs::read_dir(installed_root(root)).map_err(|err| format!("pet_list_failed: {err}"))?
    {
        let id_entry = id_entry.map_err(|err| format!("pet_list_entry_failed: {err}"))?;
        let id = id_entry.file_name().to_string_lossy().into_owned();
        if !id_entry.path().is_dir() || !valid_pet_id(&id) {
            continue;
        }
        if let Some(pet) = newest_installed_pet(root, &id)? {
            pets.push(pet);
        }
    }
    Ok(pets)
}

fn list_codex_pets_at(root: &Path) -> Vec<InstalledPet> {
    if !root.is_dir() {
        return Vec::new();
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(err) => {
            log::warn!(
                "desktop pet Codex directory scan skipped {}: {err}",
                root.display()
            );
            return Vec::new();
        }
    };
    let mut pets = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                log::warn!("desktop pet Codex directory entry skipped: {err}");
                continue;
            }
        };
        let raw_id = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().is_dir() || !valid_codex_pet_id(&raw_id) {
            continue;
        }
        match read_codex_pet(&entry.path(), Some(&raw_id), "codex", false) {
            Ok(pet) => pets.push(pet),
            Err(err) => log::warn!(
                "desktop pet ignored invalid Codex install {}: {err}",
                entry.path().display()
            ),
        }
    }
    pets
}

fn external_codex_pet(root: &Path, pet_id: &str) -> Result<Option<InstalledPet>, String> {
    let Some(raw_id) = raw_codex_pet_id(pet_id) else {
        return Ok(None);
    };
    let pet_dir = root.join(raw_id);
    if !pet_dir.is_dir() {
        return Ok(None);
    }
    read_codex_pet(&pet_dir, Some(raw_id), "codex", false).map(Some)
}

fn merge_installed_pets(
    external: Vec<InstalledPet>,
    managed: Vec<InstalledPet>,
) -> Vec<InstalledPet> {
    let mut pets_by_id = BTreeMap::new();
    for pet in external {
        pets_by_id.insert(pet.manifest.id.clone(), pet);
    }
    for pet in managed {
        pets_by_id.insert(pet.manifest.id.clone(), pet);
    }
    pets_by_id.into_values().collect()
}

#[tauri::command]
pub async fn desktop_pet_catalog(refresh: Option<bool>) -> Result<PetCatalogResponse, String> {
    load_catalog(refresh.unwrap_or(false)).await
}

#[tauri::command]
pub fn desktop_pet_list_installed() -> Result<Vec<InstalledPet>, String> {
    let root = pets_root()?;
    ensure_pet_dirs(&root)?;
    Ok(merge_installed_pets(
        list_codex_pets_at(&codex_pets_root()?),
        list_managed_pets(&root)?,
    ))
}

#[tauri::command]
pub fn desktop_pet_get_installed(pet_id: String) -> Result<Option<InstalledPet>, String> {
    let root = pets_root()?;
    ensure_pet_dirs(&root)?;
    let pet_id = pet_id.trim();
    if let Some(pet) = newest_installed_pet(&root, pet_id)? {
        return Ok(Some(pet));
    }
    external_codex_pet(&codex_pets_root()?, pet_id)
}

#[tauri::command]
pub async fn desktop_pet_install(app: AppHandle, pet_id: String) -> Result<InstalledPet, String> {
    let catalog = load_catalog(false).await?;
    let entry = catalog
        .items
        .into_iter()
        .find(|item| item.id == pet_id)
        .ok_or_else(|| "pet_catalog_item_not_found".to_string())?;
    let current_version = Version::parse(&app.package_info().version.to_string())
        .map_err(|_| "pet_app_version_invalid".to_string())?;
    let minimum_version = Version::parse(&entry.min_app_version)
        .map_err(|_| "pet_catalog_min_version_invalid".to_string())?;
    if current_version < minimum_version {
        return Err("pet_app_version_too_old".to_string());
    }

    let bytes = match download_package(&entry).await {
        Ok(bytes) if sha256_hex(&bytes) == entry.sha256.to_ascii_lowercase() => bytes,
        Ok(_) => {
            let embedded = embedded_package(&entry.id, &entry.version)
                .ok_or_else(|| "pet_download_checksum_mismatch".to_string())?;
            if sha256_hex(embedded) != entry.sha256.to_ascii_lowercase() {
                return Err("pet_download_checksum_mismatch".to_string());
            }
            embedded.to_vec()
        }
        Err(download_err) => {
            let embedded = embedded_package(&entry.id, &entry.version).ok_or(download_err)?;
            if sha256_hex(embedded) != entry.sha256.to_ascii_lowercase() {
                return Err("pet_download_checksum_mismatch".to_string());
            }
            embedded.to_vec()
        }
    };
    install_package_bytes_to_root(&pets_root()?, &bytes, Some(&entry.id), Some(&entry.version))
}

#[tauri::command]
pub fn desktop_pet_import(path: String) -> Result<InstalledPet, String> {
    let source = PathBuf::from(path);
    let metadata = fs::metadata(&source).map_err(|err| format!("pet_import_open_failed: {err}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() as usize > MAX_ARCHIVE_BYTES {
        return Err("pet_import_size_invalid".to_string());
    }
    let bytes = fs::read(&source).map_err(|err| format!("pet_import_read_failed: {err}"))?;
    install_package_bytes_to_root(&pets_root()?, &bytes, None, None)
}

#[tauri::command]
pub fn desktop_pet_uninstall(pet_id: String) -> Result<(), String> {
    let pet_id = pet_id.trim();
    if !valid_pet_id(pet_id) {
        return Err("pet_id_invalid".to_string());
    }
    let root = pets_root()?;
    let target = installed_root(&root).join(pet_id);
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|err| format!("pet_uninstall_failed: {err}"))?;
        return Ok(());
    }
    if raw_codex_pet_id(pet_id)
        .map(|raw_id| codex_pets_root().map(|root| root.join(raw_id).is_dir()))
        .transpose()?
        .unwrap_or(false)
    {
        return Err("pet_uninstall_external_unsupported".to_string());
    }
    Ok(())
}

fn window_size(scale: f64) -> (f64, f64) {
    let scale = scale.clamp(0.75, 1.5);
    (
        PET_WINDOW_BASE_WIDTH * scale,
        PET_WINDOW_BASE_HEIGHT * scale,
    )
}

fn place_default<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let Ok(window_size) = window.outer_size().or_else(|_| window.inner_size()) else {
        return;
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let x = monitor_position.x + monitor_size.width as i32
        - window_size.width as i32
        - PET_WINDOW_MARGIN;
    let y = monitor_position.y + monitor_size.height as i32
        - window_size.height as i32
        - PET_WINDOW_MARGIN
        - 40;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

#[tauri::command]
pub fn desktop_pet_window_sync(
    app: AppHandle,
    config: DesktopPetWindowConfig,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
        return if config.enabled {
            Err("pet_window_missing".to_string())
        } else {
            Ok(())
        };
    };
    if !config.enabled {
        window
            .hide()
            .map_err(|err| format!("pet_window_hide_failed: {err}"))?;
        return Ok(());
    }

    let (width, height) = window_size(config.scale);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|err| format!("pet_window_resize_failed: {err}"))?;
    window
        .set_always_on_top(config.always_on_top)
        .map_err(|err| format!("pet_window_topmost_failed: {err}"))?;
    if let Some(position) = config.position {
        window
            .set_position(PhysicalPosition::new(position.x, position.y))
            .map_err(|err| format!("pet_window_position_failed: {err}"))?;
    } else {
        place_default(&window);
    }
    window
        .show()
        .map_err(|err| format!("pet_window_show_failed: {err}"))
}

#[tauri::command]
pub fn desktop_pet_window_reset_position(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
        return Ok(());
    };
    place_default(&window);
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_window_hide(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
        return Ok(());
    };
    window
        .hide()
        .map_err(|err| format!("pet_window_hide_failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn fake_vp8x_webp(width: u32, height: u32) -> Vec<u8> {
        let mut payload = [0u8; 10];
        let width = width - 1;
        let height = height - 1;
        payload[4..7].copy_from_slice(&[width as u8, (width >> 8) as u8, (width >> 16) as u8]);
        payload[7..10].copy_from_slice(&[height as u8, (height >> 8) as u8, (height >> 16) as u8]);
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(4u32 + 8 + payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"WEBPVP8X");
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn fake_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 24];
        bytes[0..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        bytes
    }
    fn codex_manifest(id: &str, sprite_version_number: u32) -> Vec<u8> {
        serde_json::to_vec_pretty(&serde_json::json!({
            "id": id,
            "displayName": "Test Pet",
            "description": "Codex-compatible test pet",
            "spritesheetPath": "spritesheet.webp",
            "spriteVersionNumber": sprite_version_number,
            "kind": "animal"
        }))
        .unwrap()
    }

    fn write_codex_pet(root: &Path, id: &str, sprite_version_number: u32) -> PathBuf {
        let pet_dir = root.join(id);
        fs::create_dir_all(&pet_dir).unwrap();
        fs::write(
            pet_dir.join("pet.json"),
            codex_manifest(id, sprite_version_number),
        )
        .unwrap();
        let dimensions = codex_sprite_dimensions(sprite_version_number).unwrap();
        fs::write(
            pet_dir.join("spritesheet.webp"),
            fake_vp8x_webp(dimensions.0, dimensions.1),
        )
        .unwrap();
        pet_dir
    }

    fn codex_package(id: &str, sprite_version_number: u32) -> Vec<u8> {
        let dimensions = codex_sprite_dimensions(sprite_version_number).unwrap();
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            archive.start_file("pet.json", options).unwrap();
            archive
                .write_all(&codex_manifest(id, sprite_version_number))
                .unwrap();
            archive.start_file("spritesheet.webp", options).unwrap();
            archive
                .write_all(&fake_vp8x_webp(dimensions.0, dimensions.1))
                .unwrap();
            archive.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn pet_ids_and_paths_reject_unsafe_values() {
        assert!(valid_pet_id("official.pixel-fox"));
        assert!(!valid_pet_id("../pixel-fox"));
        assert!(valid_codex_pet_id("banana-cat"));
        assert!(!valid_codex_pet_id("banana--cat"));
        assert!(safe_relative_file("assets/pet.svg").is_some());
        assert!(safe_relative_file("../pet.svg").is_none());
        assert!(safe_relative_file("C:/pet.svg").is_none());
    }

    #[test]
    fn codex_webp_dimensions_support_v1_and_v2() {
        for dimensions in [(1536, 1872), (1536, 2288)] {
            assert_eq!(
                webp_dimensions(&fake_vp8x_webp(dimensions.0, dimensions.1)),
                Some(dimensions)
            );
        }
    }

    #[test]
    fn png_dimensions_reads_ihdr_dimensions() {
        assert_eq!(png_dimensions(&fake_png(320, 240)), Some((320, 240)));
        assert_eq!(png_dimensions(b"not a png"), None);
    }

    #[test]
    fn image_asset_validation_bounds_raster_decode_size() {
        let root = tempfile::tempdir().unwrap();
        let image = root.path().join("pet.png");

        fs::write(&image, fake_png(4096, 4096)).unwrap();
        assert!(validate_image_asset(&image, "png").is_ok());

        fs::write(&image, fake_png(4097, 1)).unwrap();
        assert_eq!(
            validate_image_asset(&image, "png").unwrap_err(),
            "pet_manifest_asset_dimensions_invalid"
        );

        fs::write(&image, fake_png(4096, 4097)).unwrap();
        assert_eq!(
            validate_image_asset(&image, "png").unwrap_err(),
            "pet_manifest_asset_dimensions_invalid"
        );

        fs::write(&image, b"invalid png").unwrap();
        assert_eq!(
            validate_image_asset(&image, "png").unwrap_err(),
            "pet_manifest_asset_format_invalid"
        );

        let webp = root.path().join("pet.webp");
        fs::write(&webp, b"invalid webp").unwrap();
        assert_eq!(
            validate_image_asset(&webp, "webp").unwrap_err(),
            "pet_manifest_asset_format_invalid"
        );
    }
    #[test]
    fn codex_directory_scan_namespaces_and_marks_external_pets_read_only() {
        let root = tempfile::tempdir().unwrap();
        write_codex_pet(root.path(), "banana-cat", 2);

        let pets = list_codex_pets_at(root.path());
        assert_eq!(pets.len(), 1);
        let pet = &pets[0];
        assert_eq!(pet.manifest.id, "codex.banana-cat");
        assert_eq!(pet.manifest.engine, CODEX_PET_ENGINE);
        assert_eq!(pet.manifest.sprite_version_number, Some(2));
        assert_eq!(pet.manifest.states["working"].row, Some(7));
        assert_eq!(pet.source, "codex");
        assert_eq!(pet.format, "codex");
        assert!(!pet.removable);
    }

    #[test]
    fn codex_v1_manifest_without_version_marker_is_supported() {
        let root = tempfile::tempdir().unwrap();
        let pet_dir = root.path().join("tiny-dino");
        fs::create_dir_all(&pet_dir).unwrap();
        fs::write(
            pet_dir.join("pet.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "tiny-dino",
                "displayName": "Tiny Dino",
                "description": "Legacy V1 pet",
                "spritesheetPath": "spritesheet.webp",
                "kind": "creature"
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(pet_dir.join("spritesheet.webp"), fake_vp8x_webp(1536, 1872)).unwrap();

        let pet = read_codex_pet(&pet_dir, Some("tiny-dino"), "codex", false).unwrap();
        assert_eq!(pet.manifest.sprite_version_number, Some(1));
    }

    #[test]
    fn codex_zip_import_uses_cli_manager_storage_and_overrides_external_duplicate() {
        let external_root = tempfile::tempdir().unwrap();
        write_codex_pet(external_root.path(), "banana-cat", 2);
        let external = list_codex_pets_at(external_root.path());

        let managed_root = tempfile::tempdir().unwrap();
        let installed = install_package_bytes_to_root(
            managed_root.path(),
            &codex_package("banana-cat", 2),
            None,
            None,
        )
        .unwrap();
        assert_eq!(installed.manifest.id, "codex.banana-cat");
        assert_eq!(installed.source, "cli-manager");
        assert!(installed.removable);
        assert!(Path::new(&installed.base_dir).join("pet.json").is_file());

        let merged =
            merge_installed_pets(external, list_managed_pets(managed_root.path()).unwrap());
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, "cli-manager");
    }

    #[test]
    fn embedded_catalog_and_package_hashes_match() {
        let catalog = parse_catalog(EMBEDDED_CATALOG).unwrap();
        for item in catalog.items {
            let bytes = embedded_package(&item.id, &item.version).unwrap();
            assert_eq!(sha256_hex(bytes), item.sha256);
        }
    }

    #[test]
    fn catalog_cache_replaces_existing_file_on_windows() {
        let root = tempfile::tempdir().unwrap();
        ensure_pet_dirs(root.path()).unwrap();
        write_catalog_cache(root.path(), "first").unwrap();
        write_catalog_cache(root.path(), "second").unwrap();
        assert_eq!(
            fs::read_to_string(cache_path(root.path())).unwrap(),
            "second"
        );
        assert!(fs::read_dir(root.path()).unwrap().all(|entry| {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            !name.ends_with(".tmp") && !name.ends_with(".backup")
        }));
    }

    #[test]
    fn embedded_packages_extract_and_validate() {
        let root = tempfile::tempdir().unwrap();
        for (id, version, bytes) in [
            ("official.terminal-robot", "1.0.0", TERMINAL_ROBOT_PACK),
            ("official.pixel-fox", "1.0.0", PIXEL_FOX_PACK),
            ("official.mint-slime", "1.0.0", MINT_SLIME_PACK),
        ] {
            let installed =
                install_package_bytes_to_root(root.path(), bytes, Some(id), Some(version)).unwrap();
            assert_eq!(installed.manifest.id, id);
            assert!(Path::new(&installed.base_dir).join("pet.svg").is_file());
        }
    }

    #[test]
    fn svg_validation_rejects_script_and_remote_references() {
        assert!(validate_svg("<svg><path d='M0 0'/></svg>").is_ok());
        assert!(validate_svg("<svg><script>alert(1)</script></svg>").is_err());
        assert!(validate_svg("<svg><image href='https://example.com/a.png'/></svg>").is_err());
    }
}
