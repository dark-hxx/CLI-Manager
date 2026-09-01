use crate::daemon::client::DaemonBridge;
use crate::ssh_launch::SshLaunchPlan;
use crate::ssh_transport::{validate_remote_home_path, SshRemoteHomePathError};
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;

const LEGACY_IMAGE_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_LEGACY_IMAGE_PIXELS: u64 = 12_000_000;
const MAX_ATTACHMENT_BASE64_BYTES: usize = MAX_ATTACHMENT_BYTES.div_ceil(3) * 4;
const ATTACHMENT_CHUNK_BYTES: usize = 512 * 1024;
const MAX_ATTACHMENT_ROOT_LENGTH: usize = 4096;
const LEGACY_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

#[derive(Clone, Copy)]
enum AttachmentProtocol {
    LegacyImage,
    AnyFile,
}

impl AttachmentProtocol {
    fn kind(self, operation: &str) -> String {
        match self {
            Self::LegacyImage => format!("fileAttach{operation}"),
            Self::AnyFile => format!("fileAttachAny{operation}"),
        }
    }
}

enum AttachmentSource {
    Data {
        file_name: String,
        data_base64: String,
    },
    LocalPath(String),
}

impl AttachmentSource {
    fn read(self) -> Result<(String, Vec<u8>), String> {
        match self {
            Self::Data {
                file_name,
                data_base64,
            } => decode_attachment(file_name, data_base64),
            Self::LocalPath(path) => read_attachment(path),
        }
    }
}

fn validate_plan(plan: &SshLaunchPlan) -> Result<(), String> {
    if plan.host_id.trim().is_empty()
        || plan.agent_path.trim().is_empty()
        || plan.agent_installation_id.trim().is_empty()
        || plan.agent_remote_machine_id.trim().is_empty()
        || plan.client_instance_id.trim().is_empty()
    {
        return Err("remote_file_plan_invalid".to_string());
    }
    Ok(())
}

async fn request(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    kind: &'static str,
    payload: Value,
) -> Result<Value, String> {
    validate_plan(&ssh_launch)?;
    let client = daemon_bridge
        .get()
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    tokio::task::spawn_blocking(move || {
        client.ssh_agent_request(consumer_id, ssh_launch, kind.to_string(), payload)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn validate_attachment_name(file_name: &str) -> Result<(), String> {
    if file_name.is_empty()
        || file_name.len() > 255
        || matches!(file_name, "." | "..")
        || file_name.contains(['\0', '\r', '\n', '/', '\\'])
    {
        return Err("attachment_name_invalid".to_string());
    }
    Ok(())
}

fn is_legacy_image_name(file_name: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| LEGACY_IMAGE_EXTENSIONS.contains(&extension.as_str()))
}

fn can_fallback_to_legacy_image(file_name: &str, data: &[u8]) -> bool {
    if data.len() > LEGACY_IMAGE_ATTACHMENT_BYTES || !is_legacy_image_name(file_name) {
        return false;
    }
    let Ok(reader) = image::ImageReader::new(Cursor::new(data)).with_guessed_format() else {
        return false;
    };
    reader
        .into_dimensions()
        .ok()
        .is_some_and(|(width, height)| {
            (width as u64).saturating_mul(height as u64) <= MAX_LEGACY_IMAGE_PIXELS
        })
}

fn decode_attachment(file_name: String, data_base64: String) -> Result<(String, Vec<u8>), String> {
    validate_attachment_name(&file_name)?;
    if data_base64.is_empty() || data_base64.len() > MAX_ATTACHMENT_BASE64_BYTES {
        return Err("attachment_data_invalid".to_string());
    }
    let data = general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|_| "attachment_data_invalid".to_string())?;
    validate_attachment_bytes(&data)?;
    Ok((file_name, data))
}

fn read_attachment(path: String) -> Result<(String, Vec<u8>), String> {
    if path.is_empty() || path.contains(['\0', '\r', '\n']) || !Path::new(&path).is_absolute() {
        return Err("attachment_local_path_invalid".to_string());
    }
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "attachment_local_file_unavailable".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("attachment_local_path_invalid".to_string());
    }
    if metadata.len() == 0 || metadata.len() > MAX_ATTACHMENT_BYTES as u64 {
        return Err(if metadata.len() == 0 {
            "attachment_empty".to_string()
        } else {
            "attachment_too_large".to_string()
        });
    }
    let canonical = Path::new(&path)
        .canonicalize()
        .map_err(|_| "attachment_local_file_unavailable".to_string())?;
    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "attachment_name_invalid".to_string())?
        .to_string();
    validate_attachment_name(&file_name)?;
    let file =
        fs::File::open(canonical).map_err(|_| "attachment_local_file_unavailable".to_string())?;
    let mut data = Vec::with_capacity((metadata.len() as usize).min(MAX_ATTACHMENT_BYTES));
    file.take(MAX_ATTACHMENT_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|_| "attachment_local_file_unavailable".to_string())?;
    validate_attachment_bytes(&data)?;
    Ok((file_name, data))
}

fn validate_attachment_bytes(data: &[u8]) -> Result<(), String> {
    if data.is_empty() {
        return Err("attachment_empty".to_string());
    }
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err("attachment_too_large".to_string());
    }
    Ok(())
}

fn validate_remote_attachment_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 4096
        || !path.starts_with('/')
        || path.contains(['\0', '\r', '\n', '\\'])
        || path.split('/').any(|part| part == "..")
        || !path.contains("/cli-manager-ssh-agent/attachments/")
    {
        return Err("attachment_remote_path_invalid".to_string());
    }
    Ok(())
}

fn validate_remote_file_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > MAX_ATTACHMENT_ROOT_LENGTH
        || !path.starts_with('/')
        || path.contains(['\0', '\r', '\n', '\\'])
        || path.split('/').any(|part| part == "..")
    {
        return Err("remote_file_path_invalid".to_string());
    }
    Ok(())
}

fn normalize_attachment_root(value: Option<String>) -> Result<String, String> {
    let value = value.unwrap_or_default();
    if value.len() > MAX_ATTACHMENT_ROOT_LENGTH || value.chars().any(char::is_control) {
        return Err("ssh_attachment_root_invalid".to_string());
    }
    let root = value.trim().to_string();
    if root.is_empty() {
        return Ok(root);
    }
    if root.len() > MAX_ATTACHMENT_ROOT_LENGTH {
        return Err("ssh_attachment_root_invalid".to_string());
    }
    validate_remote_home_path(&root).map_err(|error| match error {
        SshRemoteHomePathError::Invalid => "ssh_attachment_root_invalid".to_string(),
        SshRemoteHomePathError::ParentTraversal => {
            "ssh_attachment_root_parent_forbidden".to_string()
        }
    })?;
    Ok(root)
}

fn upload_attachment(
    client: &crate::daemon::client::DaemonClient,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    session_id: String,
    file_name: String,
    data: Vec<u8>,
    attachment_root: String,
) -> Result<String, String> {
    validate_plan(&ssh_launch)?;
    validate_attachment_name(&file_name)?;
    validate_attachment_bytes(&data)?;
    let attachment_root = normalize_attachment_root(Some(attachment_root))?;
    let sha256 = format!("{:x}", Sha256::digest(&data));
    let mut begin_payload = json!({
        "sessionId": session_id,
        "fileName": file_name,
        "sizeBytes": data.len(),
        "sha256": sha256,
    });
    if !attachment_root.is_empty() {
        begin_payload["attachmentRoot"] = Value::String(attachment_root);
    }
    let mut protocol = AttachmentProtocol::AnyFile;
    let begin = match client.ssh_agent_request(
        consumer_id.clone(),
        ssh_launch.clone(),
        protocol.kind("Begin"),
        begin_payload.clone(),
    ) {
        Ok(response) => response,
        Err(error)
            if error == "ssh_agent_capability_missing:fileAttachAny"
                && can_fallback_to_legacy_image(&file_name, &data) =>
        {
            protocol = AttachmentProtocol::LegacyImage;
            client.ssh_agent_request(
                consumer_id.clone(),
                ssh_launch.clone(),
                protocol.kind("Begin"),
                begin_payload,
            )?
        }
        Err(error) => return Err(error),
    };
    let upload_id = begin
        .get("uploadId")
        .and_then(Value::as_str)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or_else(|| "attachment_begin_response_invalid".to_string())?
        .to_string();

    let result = (|| {
        let mut offset = 0usize;
        for chunk in data.chunks(ATTACHMENT_CHUNK_BYTES) {
            let expected = offset + chunk.len();
            let response = client.ssh_agent_request(
                consumer_id.clone(),
                ssh_launch.clone(),
                protocol.kind("Chunk"),
                json!({
                    "uploadId": upload_id,
                    "offset": offset,
                    "dataBase64": general_purpose::STANDARD.encode(chunk),
                }),
            )?;
            if response.get("receivedBytes").and_then(Value::as_u64) != Some(expected as u64) {
                return Err("attachment_chunk_response_invalid".to_string());
            }
            offset = expected;
        }
        let response = client.ssh_agent_request(
            consumer_id.clone(),
            ssh_launch.clone(),
            protocol.kind("Finish"),
            json!({ "uploadId": upload_id }),
        )?;
        if response.get("sizeBytes").and_then(Value::as_u64) != Some(data.len() as u64) {
            return Err("attachment_finish_response_invalid".to_string());
        }
        let path = response
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "attachment_finish_response_invalid".to_string())?;
        validate_remote_attachment_path(path)?;
        Ok(path.to_string())
    })();

    if result.is_err() {
        let _ = client.ssh_agent_request(
            consumer_id,
            ssh_launch,
            protocol.kind("Abort"),
            json!({ "uploadId": upload_id }),
        );
    }
    result
}

fn upload_file_to_remote_directory(
    client: &crate::daemon::client::DaemonClient,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    remote_directory: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    validate_plan(&ssh_launch)?;
    validate_attachment_name(&file_name)?;
    validate_attachment_bytes(&data)?;
    let remote_directory = normalize_attachment_root(Some(remote_directory))?;
    if remote_directory.is_empty() {
        return Err("remote_file_root_invalid".to_string());
    }
    let sha256 = format!("{:x}", Sha256::digest(&data));
    let begin = client.ssh_agent_request(
        consumer_id.clone(),
        ssh_launch.clone(),
        "filePutBegin".to_string(),
        json!({
            "rootPath": remote_directory,
            "relativePath": "",
            "fileName": file_name,
            "sizeBytes": data.len(),
            "sha256": sha256,
        }),
    )?;
    let upload_id = begin
        .get("uploadId")
        .and_then(Value::as_str)
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
        .ok_or_else(|| "remote_file_put_begin_response_invalid".to_string())?
        .to_string();

    let result = (|| {
        let mut offset = 0usize;
        for chunk in data.chunks(ATTACHMENT_CHUNK_BYTES) {
            let expected = offset + chunk.len();
            let response = client.ssh_agent_request(
                consumer_id.clone(),
                ssh_launch.clone(),
                "filePutChunk".to_string(),
                json!({
                    "uploadId": upload_id,
                    "offset": offset,
                    "dataBase64": general_purpose::STANDARD.encode(chunk),
                }),
            )?;
            if response.get("receivedBytes").and_then(Value::as_u64) != Some(expected as u64) {
                return Err("remote_file_put_chunk_response_invalid".to_string());
            }
            offset = expected;
        }
        let response = client.ssh_agent_request(
            consumer_id.clone(),
            ssh_launch.clone(),
            "filePutFinish".to_string(),
            json!({ "uploadId": upload_id }),
        )?;
        if response.get("sizeBytes").and_then(Value::as_u64) != Some(data.len() as u64) {
            return Err("remote_file_put_finish_response_invalid".to_string());
        }
        let path = response
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "remote_file_put_finish_response_invalid".to_string())?;
        validate_remote_file_path(path)?;
        Ok(path.to_string())
    })();

    if result.is_err() {
        let _ = client.ssh_agent_request(
            consumer_id,
            ssh_launch,
            "filePutAbort".to_string(),
            json!({ "uploadId": upload_id }),
        );
    }
    result
}

async fn attach(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    session_id: String,
    attachment_root: Option<String>,
    attachment: AttachmentSource,
) -> Result<String, String> {
    let attachment_root = normalize_attachment_root(attachment_root)?;
    let client = daemon_bridge
        .get()
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    tokio::task::spawn_blocking(move || {
        let (file_name, data) = attachment.read()?;
        upload_attachment(
            client.as_ref(),
            consumer_id,
            ssh_launch,
            session_id,
            file_name,
            data,
            attachment_root,
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn ssh_remote_file_attach_data(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    session_id: String,
    file_name: String,
    data_base64: String,
    attachment_root: Option<String>,
) -> Result<String, String> {
    attach(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        session_id,
        attachment_root,
        AttachmentSource::Data {
            file_name,
            data_base64,
        },
    )
    .await
}

#[tauri::command]
pub async fn ssh_remote_file_attach_path(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    session_id: String,
    local_path: String,
    attachment_root: Option<String>,
) -> Result<String, String> {
    attach(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        session_id,
        attachment_root,
        AttachmentSource::LocalPath(local_path),
    )
    .await
}

#[tauri::command]
pub async fn ssh_remote_file_put_path(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    root_path: String,
    local_path: String,
) -> Result<String, String> {
    let root_path = normalize_attachment_root(Some(root_path))?;
    if root_path.is_empty() {
        return Err("remote_file_root_invalid".to_string());
    }
    let client = daemon_bridge
        .get()
        .ok_or_else(|| "daemon_unavailable".to_string())?;
    tokio::task::spawn_blocking(move || {
        let (file_name, data) = read_attachment(local_path)?;
        upload_file_to_remote_directory(
            client.as_ref(),
            consumer_id,
            ssh_launch,
            root_path,
            file_name,
            data,
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn ssh_remote_file_attachment_root(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    attachment_root: Option<String>,
) -> Result<Value, String> {
    let attachment_root = normalize_attachment_root(attachment_root)?;
    request(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        "fileAttachmentRoot",
        json!({ "attachmentRoot": attachment_root }),
    )
    .await
}

#[tauri::command]
pub async fn ssh_remote_file_list(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    root_path: String,
    relative_path: String,
) -> Result<Value, String> {
    request(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        "fileList",
        json!({ "rootPath": root_path, "relativePath": relative_path }),
    )
    .await
}

#[tauri::command]
pub async fn ssh_remote_file_read(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    root_path: String,
    relative_path: String,
) -> Result<Value, String> {
    request(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        "fileRead",
        json!({ "rootPath": root_path, "relativePath": relative_path }),
    )
    .await
}

#[tauri::command]
pub async fn ssh_remote_file_search(
    daemon_bridge: tauri::State<'_, DaemonBridge>,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    root_path: String,
    query: String,
    content: bool,
) -> Result<Value, String> {
    request(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        "fileSearch",
        json!({ "rootPath": root_path, "query": query, "content": content }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        can_fallback_to_legacy_image, decode_attachment, is_legacy_image_name,
        normalize_attachment_root, read_attachment, validate_attachment_name,
        validate_remote_attachment_path, validate_remote_file_path, MAX_ATTACHMENT_BYTES,
    };
    use base64::{engine::general_purpose, Engine as _};
    use std::fs;

    #[test]
    fn attachment_names_accept_safe_regular_file_names() {
        assert!(validate_attachment_name("shot.PNG").is_ok());
        assert!(validate_attachment_name("notes.txt").is_ok());
        assert!(validate_attachment_name(".env").is_ok());
        assert!(validate_attachment_name("LICENSE").is_ok());
        assert!(is_legacy_image_name("shot.webp"));
        assert!(!is_legacy_image_name("notes.txt"));
        assert!(!can_fallback_to_legacy_image("shot.png", b"not-an-image"));
        assert!(validate_attachment_name("../shot.png").is_err());
        assert!(validate_attachment_name("folder\\shot.png").is_err());
        assert!(validate_attachment_name("../shot.png\n").is_err());
    }

    #[test]
    fn remote_attachment_paths_are_absolute_and_cache_scoped() {
        assert!(validate_remote_attachment_path(
            "/home/dev/.cache/cli-manager-ssh-agent/attachments/session/id.png"
        )
        .is_ok());
        assert!(validate_remote_attachment_path(
            "/srv/xdg-cache/cli-manager-ssh-agent/attachments/session/id.png"
        )
        .is_ok());
        assert!(
            validate_remote_attachment_path("/project/.cli-manager/attachments/id.png").is_err()
        );
        assert!(validate_remote_attachment_path(
            "/home/dev/.cache/cli-manager-ssh-agent/attachments/../secret.png"
        )
        .is_err());
    }

    #[test]
    fn remote_file_put_paths_are_absolute_without_traversal() {
        assert!(validate_remote_file_path("/data/file.txt").is_ok());
        assert!(validate_remote_file_path("/data/../etc/passwd").is_err());
        assert!(validate_remote_file_path("~/data/file.txt").is_err());
        assert!(validate_remote_file_path("/data\\file.txt").is_err());
    }

    #[test]
    fn attachment_roots_allow_home_paths_but_reject_escape_inputs() {
        assert_eq!(
            normalize_attachment_root(Some(" ~/attachments ".to_string())).unwrap(),
            "~/attachments"
        );
        assert!(normalize_attachment_root(Some("attachments".to_string())).is_err());
        assert_eq!(
            normalize_attachment_root(Some("~/../outside".to_string())).unwrap_err(),
            "ssh_attachment_root_parent_forbidden"
        );
        assert!(normalize_attachment_root(Some("$HOME/files".to_string())).is_err());
        assert!(normalize_attachment_root(Some("/tmp/files\nmore".to_string())).is_err());
        assert_eq!(normalize_attachment_root(None).unwrap(), "");
    }

    #[test]
    fn attachment_data_and_local_paths_are_bounded_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pixel.png");
        image::save_buffer_with_format(
            &path,
            &[0, 0, 0, 0],
            1,
            1,
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        )
        .unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(can_fallback_to_legacy_image("pixel.png", &bytes));
        let (_, decoded) =
            decode_attachment("pixel.png".into(), general_purpose::STANDARD.encode(&bytes))
                .unwrap();
        assert_eq!(decoded, bytes);
        let (name, loaded) = read_attachment(path.display().to_string()).unwrap();
        assert_eq!(name, "pixel.png");
        assert_eq!(loaded, bytes);

        let text_path = root.path().join("notes.txt");
        fs::write(&text_path, b"hello").unwrap();
        let (name, loaded) = read_attachment(text_path.display().to_string()).unwrap();
        assert_eq!(name, "notes.txt");
        assert_eq!(loaded, b"hello");

        let oversized = root.path().join("oversized.bin");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_ATTACHMENT_BYTES as u64 + 1)
            .unwrap();
        assert_eq!(
            read_attachment(oversized.display().to_string()).unwrap_err(),
            "attachment_too_large"
        );
    }
}
