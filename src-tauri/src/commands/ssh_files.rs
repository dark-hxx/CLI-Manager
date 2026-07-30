use crate::daemon::client::DaemonBridge;
use crate::ssh_launch::SshLaunchPlan;
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BASE64_BYTES: usize = MAX_ATTACHMENT_BYTES.div_ceil(3) * 4;
const ATTACHMENT_CHUNK_BYTES: usize = 512 * 1024;
const ATTACHMENT_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

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
    if file_name.is_empty() || file_name.len() > 255 || file_name.contains(['\0', '\r', '\n']) {
        return Err("attachment_name_invalid".to_string());
    }
    let supported = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|extension| ATTACHMENT_EXTENSIONS.contains(&extension.as_str()));
    if !supported {
        return Err("attachment_type_unsupported".to_string());
    }
    Ok(())
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
    let data = fs::read(canonical).map_err(|_| "attachment_local_file_unavailable".to_string())?;
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

fn upload_attachment(
    client: &crate::daemon::client::DaemonClient,
    consumer_id: String,
    ssh_launch: SshLaunchPlan,
    session_id: String,
    file_name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    validate_plan(&ssh_launch)?;
    validate_attachment_name(&file_name)?;
    validate_attachment_bytes(&data)?;
    let sha256 = format!("{:x}", Sha256::digest(&data));
    let begin = client.ssh_agent_request(
        consumer_id.clone(),
        ssh_launch.clone(),
        "fileAttachBegin".to_string(),
        json!({
            "sessionId": session_id,
            "fileName": file_name,
            "sizeBytes": data.len(),
            "sha256": sha256,
        }),
    )?;
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
                "fileAttachChunk".to_string(),
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
            "fileAttachFinish".to_string(),
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
            "fileAttachAbort".to_string(),
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
    attachment: AttachmentSource,
) -> Result<String, String> {
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
) -> Result<String, String> {
    attach(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        session_id,
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
) -> Result<String, String> {
    attach(
        daemon_bridge,
        consumer_id,
        ssh_launch,
        session_id,
        AttachmentSource::LocalPath(local_path),
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
        decode_attachment, read_attachment, validate_attachment_name,
        validate_remote_attachment_path,
    };
    use base64::{engine::general_purpose, Engine as _};
    use std::fs;

    #[test]
    fn attachment_names_use_an_image_allowlist() {
        assert!(validate_attachment_name("shot.PNG").is_ok());
        assert!(validate_attachment_name("shot.webp").is_ok());
        assert_eq!(
            validate_attachment_name("notes.txt").unwrap_err(),
            "attachment_type_unsupported"
        );
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
    fn attachment_data_and_local_paths_are_bounded_images() {
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
        let (_, decoded) =
            decode_attachment("pixel.png".into(), general_purpose::STANDARD.encode(&bytes))
                .unwrap();
        assert_eq!(decoded, bytes);
        let (name, loaded) = read_attachment(path.display().to_string()).unwrap();
        assert_eq!(name, "pixel.png");
        assert_eq!(loaded, bytes);
    }
}
