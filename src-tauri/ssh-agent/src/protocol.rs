use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
#[cfg(unix)]
use std::fs;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::path::{Path, PathBuf};

use crate::files::{
    FileAttachAbortRequest, FileAttachBeginRequest, FileAttachChunkRequest,
    FileAttachFinishRequest, FileAttachmentRootRequest, FileAttachmentUploads, FileDeleteRequest,
    FileGetRequest, FileListRequest, FilePutBeginRequest, FileReadRequest, FileSearchRequest,
};
use crate::history::{
    HistoryGetRequest, HistoryResumePreflightRequest, HistoryScopeRequest, HistorySearchRequest,
};
use crate::hook_runtime::{ack_spool, read_spool_batch, spool_namespace};
#[cfg(unix)]
use crate::hook_runtime::{bridge_pid_file_name, bridge_socket_file_name};
use crate::installer::read_installation_record;
use crate::layout::resolve_layout;
use crate::{PROTOCOL_MAJOR, PROTOCOL_MINOR};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_PREAMBLE_BANNER_BYTES: usize = 8 * 1024;
const MAX_CANCELLED_REQUESTS: usize = 1024;
const HISTORY_DETAIL_CHUNK_BYTES: usize = 256 * 1024;
const MAX_HISTORY_DETAIL_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const FILE_GET_CHUNK_BYTES: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientFrame {
    pub request_id: String,
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFrame {
    pub request_id: String,
    pub kind: String,
    pub payload: Value,
}

struct HookBridgeBinding {
    namespace: String,
    remote_machine_id: String,
    #[cfg(unix)]
    socket: std::os::unix::net::UnixDatagram,
    #[cfg(unix)]
    socket_path: PathBuf,
    #[cfg(unix)]
    pid_path: PathBuf,
}

#[derive(Default)]
struct CancelledRequests {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl CancelledRequests {
    // 记录新的取消 ID 并按插入顺序淘汰超过 1024 项的旧记录；重复 ID 返回 false 且不刷新顺序。
    fn insert(&mut self, request_id: &str) -> bool {
        if !self.ids.insert(request_id.to_string()) {
            return false;
        }
        self.order.push_back(request_id.to_string());
        while self.order.len() > MAX_CANCELLED_REQUESTS {
            if let Some(removed) = self.order.pop_front() {
                self.ids.remove(&removed);
            }
        }
        true
    }

    // 消费一次取消标记，并同步清除顺序队列中的同 ID 项，避免重新插入后被旧条目淘汰。
    fn take(&mut self, request_id: &str) -> bool {
        if !self.ids.remove(request_id) {
            return false;
        }
        self.order.retain(|queued| queued != request_id);
        true
    }
}

#[cfg(unix)]
impl Drop for HookBridgeBinding {
    // 释放 Unix Hook 绑定时尽力删除 socket 和 PID 文件，清理错误不传播。
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket_path);
        let _ = fs::remove_file(&self.pid_path);
    }
}

// 要求绑定值非空、最多 256 字节，且不含控制字符或路径分隔符；不要求 UUID。
fn valid_binding_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains(['\0', '\r', '\n', '/', '\\'])
}

// 要求请求 ID 非空、最多 256 字节且无 NUL/回车/换行；不校验 UUID 或全局唯一性。
fn valid_request_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.contains(['\0', '\r', '\n'])
}

#[cfg(unix)]
// 读取 PID 后仅通过 /proc 项是否存在判断存活；无 /proc、读取失败或无效 PID 均返回 false。
fn process_alive(pid_path: &Path) -> bool {
    let Some(pid) = fs::read_to_string(pid_path)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
    else {
        return false;
    };
    Path::new("/proc").is_dir() && Path::new("/proc").join(pid.to_string()).exists()
}

// 校验主机、客户端和安装 UUID，并要求与本地安装记录一致，生成隔离的 Hook namespace。
// Unix 另建受限权限 socket/PID 文件；完成构造前发生错误时，没有统一清理已创建路径的守卫。
fn bind_hook_bridge(payload: &Value) -> Result<HookBridgeBinding, String> {
    let client_instance_id = payload
        .get("clientInstanceId")
        .and_then(Value::as_str)
        .filter(|value| valid_binding_value(value))
        .ok_or_else(|| "bridge_client_instance_invalid".to_string())?;
    let host_id = payload
        .get("hostId")
        .and_then(Value::as_str)
        .filter(|value| valid_binding_value(value))
        .ok_or_else(|| "bridge_host_id_invalid".to_string())?;
    let installation_id = payload
        .get("installationId")
        .and_then(Value::as_str)
        .ok_or_else(|| "bridge_installation_id_invalid".to_string())?;
    uuid::Uuid::parse_str(installation_id)
        .map_err(|_| "bridge_installation_id_invalid".to_string())?;
    let layout = resolve_layout().map_err(str::to_string)?;
    let installed = read_installation_record(&layout)?
        .ok_or_else(|| "agent_installation_record_missing".to_string())?;
    if installed.installation_id != installation_id {
        return Err("bridge_installation_id_mismatch".to_string());
    }
    let namespace = spool_namespace(host_id, client_instance_id, installation_id);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixDatagram;
        fs::create_dir_all(&layout.runtime_dir)
            .map_err(|_| "bridge_runtime_dir_failed".to_string())?;
        fs::set_permissions(&layout.runtime_dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "bridge_runtime_permissions_failed".to_string())?;
        let socket_path = layout.runtime_dir.join(bridge_socket_file_name(&namespace));
        let pid_path = layout.runtime_dir.join(bridge_pid_file_name(&namespace));
        if socket_path.exists() || pid_path.exists() {
            if process_alive(&pid_path) {
                return Err("bridge_already_active".to_string());
            }
            let _ = fs::remove_file(&socket_path);
            let _ = fs::remove_file(&pid_path);
        }
        let socket = UnixDatagram::bind(&socket_path)
            .map_err(|_| "bridge_hook_socket_bind_failed".to_string())?;
        socket
            .set_nonblocking(true)
            .map_err(|_| "bridge_hook_socket_nonblocking_failed".to_string())?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "bridge_hook_socket_permissions_failed".to_string())?;
        fs::write(&pid_path, std::process::id().to_string())
            .map_err(|_| "bridge_hook_pid_write_failed".to_string())?;
        fs::set_permissions(&pid_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "bridge_hook_pid_permissions_failed".to_string())?;
        return Ok(HookBridgeBinding {
            namespace,
            remote_machine_id: installed.remote_machine_id,
            socket,
            socket_path,
            pid_path,
        });
    }
    #[cfg(not(unix))]
    Ok(HookBridgeBinding {
        namespace,
        remote_machine_id: installed.remote_machine_id,
    })
}

// Unix 上循环消费通知数据报直到无数据或出错，不解析序号；非 Unix 不执行操作。
fn drain_hook_notifications(binding: &HookBridgeBinding) {
    #[cfg(unix)]
    loop {
        let mut buffer = [0u8; 32];
        match binding.socket.recv(&mut buffer) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(_) => break,
        }
    }
    #[cfg(not(unix))]
    let _ = binding;
}

// Unix 尝试临时切到带超时的阻塞接收，随后恢复非阻塞并排空通知；配置及接收错误均忽略。
// 非 Unix 直接休眠指定时长；实际 Hook 事件仍由后续 spool 读取获取。
fn wait_for_hook_notification(binding: &HookBridgeBinding, wait: std::time::Duration) {
    #[cfg(unix)]
    {
        let _ = binding.socket.set_nonblocking(false);
        let _ = binding.socket.set_read_timeout(Some(wait));
        let mut buffer = [0u8; 32];
        let _ = binding.socket.recv(&mut buffer);
        let _ = binding.socket.set_read_timeout(None);
        let _ = binding.socket.set_nonblocking(true);
        drain_hook_notifications(binding);
    }
    #[cfg(not(unix))]
    {
        let _ = binding;
        std::thread::sleep(wait);
    }
}

// 输出协议主版本和调用方 nonce 的单行前导并刷新；此函数不校验 nonce 文本。
pub fn write_preamble(writer: &mut impl Write, nonce: &str) -> io::Result<()> {
    writeln!(writer, "CLI_MANAGER_SSH_AGENT/{PROTOCOL_MAJOR} {nonce}")?;
    writer.flush()
}

// 先读四字节大端长度并限制为非零且不超过 1 MiB，再精确读取 JSON 客户端帧。
// 未开始新帧时的 EOF 返回 None；截断长度或载荷返回错误，身份字段留给运行循环校验。
pub fn read_frame(reader: &mut impl Read) -> Result<Option<ClientFrame>, String> {
    let mut length = [0u8; 4];
    match reader.read(&mut length[..1]) {
        Ok(0) => return Ok(None),
        Ok(1) => {}
        Ok(_) => unreachable!("single-byte read returned more than one byte"),
        Err(error) => return Err(format!("frame_length_read_failed:{error}")),
    }
    reader
        .read_exact(&mut length[1..])
        .map_err(|error| format!("frame_length_read_failed:{error}"))?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("frame_size_invalid".to_string());
    }
    let mut payload = vec![0u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("frame_payload_read_failed:{error}"))?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| format!("frame_json_invalid:{error}"))
}

// 序列化服务端帧，检查 1 MiB 上限后写大端长度、JSON 并刷新；写入失败不回滚已发字节。
pub fn write_frame(writer: &mut impl Write, frame: &ServerFrame) -> Result<(), String> {
    let payload =
        serde_json::to_vec(frame).map_err(|error| format!("frame_json_encode_failed:{error}"))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err("frame_size_invalid".to_string());
    }
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(&payload))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("frame_write_failed:{error}"))
}

// 组装请求 ID、响应类型和 JSON 载荷，不执行额外身份或大小校验。
fn response(request_id: String, kind: &str, payload: Value) -> ServerFrame {
    ServerFrame {
        request_id,
        kind: kind.to_string(),
        payload,
    }
}

// 返回编译时固定的 bridge 能力列表，不实时探测远端工具或当前请求权限。
fn capabilities() -> Value {
    json!([
        "bridgeProtocol",
        "hookSpool",
        "heartbeat",
        "requestCancellation",
        "boundedBackpressure",
        "agentCapabilitiesV1",
        "historyIndex",
        "historySearch",
        "historyDetail",
        "historyDetailChunks",
        "historyResumePreflight",
        "fileList",
        "fileRead",
        "fileSearch",
        "fileGet",
        "fileDelete",
        "fileAttach",
        "fileAttachAny",
        "fileAttachCustomRoot",
        "fileAttachmentRoot",
        "filePut",
        "gitListRepositories",
        "gitChanges",
        "gitDiff",
        "gitDiffOptions",
        "gitHistory",
        "gitBranchStatus",
        "gitBranches",
        "gitOperationContinue",
        "gitOperationAbort",
        "gitWorkspaceTools",
        "gitFull"
    ])
}

// 按最多 256 KiB 并沿 UTF-8 字符边界切分已序列化文本，返回借用切片；空输入无分片。
fn history_detail_chunks(serialized: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < serialized.len() {
        let mut end = start
            .saturating_add(HISTORY_DETAIL_CHUNK_BYTES)
            .min(serialized.len());
        while end > start && !serialized.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&serialized[start..end]);
        start = end;
    }
    chunks
}

// 按顺序发送带 index/total 的历史详情文本分片，每帧单独校验和刷新；失败时可能已发送前缀。
fn write_history_detail_chunks(
    writer: &mut impl Write,
    request_id: &str,
    serialized: &str,
) -> Result<(), String> {
    let chunks = history_detail_chunks(serialized);
    let total = chunks.len();
    for (index, data) in chunks.into_iter().enumerate() {
        write_frame(
            writer,
            &response(
                request_id.to_string(),
                "historyDetailChunk",
                json!({ "index": index, "total": total, "data": data }),
            ),
        )?;
    }
    Ok(())
}

// 把已整体读取的文件按 512 KiB 编码为 Base64 帧并附元数据；空文件也发送一个空分片。
fn write_file_get_chunks(
    writer: &mut impl Write,
    request_id: &str,
    download: crate::files::FileDownload,
) -> Result<(), String> {
    let total = download.data.len().div_ceil(FILE_GET_CHUNK_BYTES).max(1);
    for index in 0..total {
        let start = index * FILE_GET_CHUNK_BYTES;
        let end = start
            .saturating_add(FILE_GET_CHUNK_BYTES)
            .min(download.data.len());
        let chunk = &download.data[start..end];
        write_frame(
            writer,
            &response(
                request_id.to_string(),
                "fileGetChunk",
                json!({
                    "index": index,
                    "total": total,
                    "dataBase64": general_purpose::STANDARD.encode(chunk),
                    "relativePath": download.relative_path.clone(),
                    "sizeBytes": download.size_bytes,
                    "modifiedMs": download.modified_ms,
                }),
            ),
        )?;
    }
    Ok(())
}

// 处理无状态 hello、ping 和 shutdown，其他类型返回不支持；此辅助入口本身不建立 Hook 绑定。
pub fn handle_frame(frame: ClientFrame) -> (ServerFrame, bool) {
    let ClientFrame {
        request_id,
        kind,
        payload,
    } = frame;
    match kind.as_str() {
        "hello" => (
            response(
                request_id,
                "helloOk",
                json!({
                    "protocolMajor": PROTOCOL_MAJOR,
                    "protocolMinor": PROTOCOL_MINOR,
                    "capabilities": capabilities(),
                }),
            ),
            false,
        ),
        "ping" => (response(request_id, "pong", payload), false),
        "shutdown" => (
            response(request_id, "response", json!({ "accepted": true })),
            true,
        ),
        _ => (
            response(
                request_id,
                "error",
                json!({ "code": "unsupported_message", "messageKind": kind }),
            ),
            false,
        ),
    }
}

// 写前导后串行读取并分派历史、能力、文件、Git 和 Hook 请求，保留本连接的取消标记与上传状态。
// 取消只拦截后续同 ID 非 cancel 请求，不中断正在执行的操作；仅 Hook drain/ack 显式要求先 hello 绑定。
// 请求业务错误通常写入响应继续处理，帧读写或部分布局错误结束循环；shutdown 响应写出后退出。
pub fn run_bridge(
    reader: &mut impl Read,
    writer: &mut impl Write,
    nonce: &str,
) -> Result<(), String> {
    write_preamble(writer, nonce).map_err(|error| format!("preamble_write_failed:{error}"))?;
    let mut hook_binding = None;
    let mut cancelled_requests = CancelledRequests::default();
    let mut attachment_uploads = FileAttachmentUploads::default();
    while let Some(frame) = read_frame(reader)? {
        let request_id = frame.request_id.clone();
        if !valid_request_id(&request_id)
            || frame.kind.is_empty()
            || frame.kind.len() > 64
            || frame.kind.contains(['\0', '\r', '\n'])
        {
            return Err("frame_identity_invalid".to_string());
        }
        if frame.kind != "cancel" && cancelled_requests.take(&request_id) {
            write_frame(
                writer,
                &response(request_id, "error", json!({ "code": "request_cancelled" })),
            )?;
            continue;
        }
        if frame.kind == "historyGet" {
            let response = match serde_json::from_value::<HistoryGetRequest>(frame.payload) {
                Ok(request) => match crate::history::get(request) {
                    Ok(result) => match serde_json::to_string(&result) {
                        Ok(serialized) if serialized.len() <= MAX_HISTORY_DETAIL_RESPONSE_BYTES => {
                            write_history_detail_chunks(writer, &request_id, &serialized)?;
                            continue;
                        }
                        Ok(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "history_detail_too_large" }),
                        ),
                        Err(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "history_response_invalid" }),
                        ),
                    },
                    Err(code) => response(request_id, "error", json!({ "code": code })),
                },
                Err(_) => response(
                    request_id,
                    "error",
                    json!({ "code": "history_request_invalid" }),
                ),
            };
            write_frame(writer, &response)?;
            continue;
        }
        if matches!(
            frame.kind.as_str(),
            "agentCapabilitiesInspect" | "agentCapabilitiesProbe"
        ) {
            let probe = frame.kind == "agentCapabilitiesProbe";
            let response = match serde_json::from_value::<
                cli_manager_agent_capabilities::InspectRequest,
            >(frame.payload)
            {
                Ok(request) => match crate::agent_capabilities::execute(request, probe) {
                    Ok(result) => response(
                        request_id,
                        "response",
                        serde_json::to_value(result).unwrap_or(Value::Null),
                    ),
                    Err(code) => response(request_id, "error", json!({ "code": code })),
                },
                Err(_) => response(
                    request_id,
                    "error",
                    json!({ "code": "agent_capability_request_invalid" }),
                ),
            };
            write_frame(writer, &response)?;
            continue;
        }
        if frame.kind == "historyResumePreflight" {
            let response =
                match serde_json::from_value::<HistoryResumePreflightRequest>(frame.payload) {
                    Ok(request) => match crate::history::resume_preflight(request) {
                        Ok(result) => response(
                            request_id,
                            "response",
                            serde_json::to_value(result).unwrap_or(Value::Null),
                        ),
                        Err(code) => response(request_id, "error", json!({ "code": code })),
                    },
                    Err(_) => response(
                        request_id,
                        "error",
                        json!({ "code": "history_resume_request_invalid" }),
                    ),
                };
            write_frame(writer, &response)?;
            continue;
        }
        if matches!(
            frame.kind.as_str(),
            "fileAttachBegin"
                | "fileAttachChunk"
                | "fileAttachFinish"
                | "fileAttachAbort"
                | "fileAttachAnyBegin"
                | "fileAttachAnyChunk"
                | "fileAttachAnyFinish"
                | "fileAttachAnyAbort"
                | "filePutBegin"
                | "filePutChunk"
                | "filePutFinish"
                | "filePutAbort"
        ) {
            let response = match frame.kind.as_str() {
                "fileAttachBegin" | "fileAttachAnyBegin" => {
                    let any_file = frame.kind == "fileAttachAnyBegin";
                    match serde_json::from_value::<FileAttachBeginRequest>(frame.payload) {
                        Ok(request) => match if any_file {
                            attachment_uploads.begin_any(request)
                        } else {
                            attachment_uploads.begin(request)
                        } {
                            Ok(result) => response(
                                request_id,
                                "response",
                                serde_json::to_value(result).unwrap_or(Value::Null),
                            ),
                            Err(code) => response(request_id, "error", json!({ "code": code })),
                        },
                        Err(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "remote_file_attachment_request_invalid" }),
                        ),
                    }
                }
                "fileAttachChunk" | "fileAttachAnyChunk" => {
                    match serde_json::from_value::<FileAttachChunkRequest>(frame.payload) {
                        Ok(request) => match attachment_uploads.append(request) {
                            Ok(received_bytes) => response(
                                request_id,
                                "response",
                                json!({ "receivedBytes": received_bytes }),
                            ),
                            Err(code) => response(request_id, "error", json!({ "code": code })),
                        },
                        Err(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "remote_file_attachment_request_invalid" }),
                        ),
                    }
                }
                "fileAttachFinish" | "fileAttachAnyFinish" => {
                    match serde_json::from_value::<FileAttachFinishRequest>(frame.payload) {
                        Ok(request) => match attachment_uploads.finish(request) {
                            Ok(result) => response(
                                request_id,
                                "response",
                                serde_json::to_value(result).unwrap_or(Value::Null),
                            ),
                            Err(code) => response(request_id, "error", json!({ "code": code })),
                        },
                        Err(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "remote_file_attachment_request_invalid" }),
                        ),
                    }
                }
                "filePutBegin" => {
                    match serde_json::from_value::<FilePutBeginRequest>(frame.payload) {
                        Ok(request) => match attachment_uploads.begin_put(request) {
                            Ok(result) => response(
                                request_id,
                                "response",
                                serde_json::to_value(result).unwrap_or(Value::Null),
                            ),
                            Err(code) => response(request_id, "error", json!({ "code": code })),
                        },
                        Err(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "remote_file_upload_request_invalid" }),
                        ),
                    }
                }
                "filePutChunk" => {
                    match serde_json::from_value::<FileAttachChunkRequest>(frame.payload) {
                        Ok(request) => match attachment_uploads.append(request) {
                            Ok(received_bytes) => response(
                                request_id,
                                "response",
                                json!({ "receivedBytes": received_bytes }),
                            ),
                            Err(code) => response(request_id, "error", json!({ "code": code })),
                        },
                        Err(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "remote_file_upload_request_invalid" }),
                        ),
                    }
                }
                "filePutFinish" => {
                    match serde_json::from_value::<FileAttachFinishRequest>(frame.payload) {
                        Ok(request) => match attachment_uploads.finish(request) {
                            Ok(result) => response(
                                request_id,
                                "response",
                                serde_json::to_value(result).unwrap_or(Value::Null),
                            ),
                            Err(code) => response(request_id, "error", json!({ "code": code })),
                        },
                        Err(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "remote_file_upload_request_invalid" }),
                        ),
                    }
                }
                "filePutAbort" => {
                    match serde_json::from_value::<FileAttachAbortRequest>(frame.payload) {
                        Ok(request) => {
                            let accepted = attachment_uploads.abort(request);
                            response(request_id, "response", json!({ "accepted": accepted }))
                        }
                        Err(_) => response(
                            request_id,
                            "error",
                            json!({ "code": "remote_file_upload_request_invalid" }),
                        ),
                    }
                }
                _ => match serde_json::from_value::<FileAttachAbortRequest>(frame.payload) {
                    Ok(request) => {
                        let accepted = attachment_uploads.abort(request);
                        response(request_id, "response", json!({ "accepted": accepted }))
                    }
                    Err(_) => response(
                        request_id,
                        "error",
                        json!({ "code": "remote_file_attachment_request_invalid" }),
                    ),
                },
            };
            write_frame(writer, &response)?;
            continue;
        }
        if frame.kind == "fileGet" {
            match serde_json::from_value::<FileGetRequest>(frame.payload) {
                Ok(request) => match crate::files::read_download(request) {
                    Ok(download) => write_file_get_chunks(writer, &request_id, download)?,
                    Err(code) => write_frame(
                        writer,
                        &response(request_id, "error", json!({ "code": code })),
                    )?,
                },
                Err(_) => write_frame(
                    writer,
                    &response(
                        request_id,
                        "error",
                        json!({ "code": "remote_file_request_invalid" }),
                    ),
                )?,
            }
            continue;
        }
        if frame.kind == "fileDelete" {
            let response = match serde_json::from_value::<FileDeleteRequest>(frame.payload) {
                Ok(request) => match crate::files::delete(request) {
                    Ok(result) => response(
                        request_id,
                        "response",
                        serde_json::to_value(result).unwrap_or(Value::Null),
                    ),
                    Err(code) => response(request_id, "error", json!({ "code": code })),
                },
                Err(_) => response(
                    request_id,
                    "error",
                    json!({ "code": "remote_file_request_invalid" }),
                ),
            };
            write_frame(writer, &response)?;
            continue;
        }
        if frame.kind == "fileAttachmentRoot" {
            let response = match serde_json::from_value::<FileAttachmentRootRequest>(frame.payload)
            {
                Ok(request) => match crate::files::attachment_root(request) {
                    Ok(result) => response(
                        request_id,
                        "response",
                        serde_json::to_value(result).unwrap_or(Value::Null),
                    ),
                    Err(code) => response(request_id, "error", json!({ "code": code })),
                },
                Err(_) => response(
                    request_id,
                    "error",
                    json!({ "code": "remote_file_attachment_request_invalid" }),
                ),
            };
            write_frame(writer, &response)?;
            continue;
        }
        if matches!(frame.kind.as_str(), "fileList" | "fileRead" | "fileSearch") {
            let response = match frame.kind.as_str() {
                "fileList" => match serde_json::from_value::<FileListRequest>(frame.payload) {
                    Ok(request) => match crate::files::list(request) {
                        Ok(entries) => {
                            response(request_id, "response", json!({ "entries": entries }))
                        }
                        Err(code) => response(request_id, "error", json!({ "code": code })),
                    },
                    Err(_) => response(
                        request_id,
                        "error",
                        json!({ "code": "remote_file_request_invalid" }),
                    ),
                },
                "fileRead" => match serde_json::from_value::<FileReadRequest>(frame.payload) {
                    Ok(request) => match crate::files::read(request) {
                        Ok(result) => response(
                            request_id,
                            "response",
                            serde_json::to_value(result).unwrap_or(Value::Null),
                        ),
                        Err(code) => response(request_id, "error", json!({ "code": code })),
                    },
                    Err(_) => response(
                        request_id,
                        "error",
                        json!({ "code": "remote_file_request_invalid" }),
                    ),
                },
                _ => match serde_json::from_value::<FileSearchRequest>(frame.payload) {
                    Ok(request) => match crate::files::search(request) {
                        Ok(entries) => {
                            response(request_id, "response", json!({ "entries": entries }))
                        }
                        Err(code) => response(request_id, "error", json!({ "code": code })),
                    },
                    Err(_) => response(
                        request_id,
                        "error",
                        json!({ "code": "remote_file_request_invalid" }),
                    ),
                },
            };
            write_frame(writer, &response)?;
            continue;
        }

        if frame.kind.starts_with("git") {
            let request_id = frame.request_id.clone();
            let response = match crate::git::dispatch(&frame.kind, frame.payload) {
                Ok(payload) => response(request_id, "response", payload),
                Err(code) => response(request_id, "error", json!({ "code": code })),
            };
            write_frame(writer, &response)?;
            continue;
        }
        let (response, shutdown) = match frame.kind.as_str() {
            "hello" if hook_binding.is_some() => (
                response(
                    request_id,
                    "error",
                    json!({ "code": "bridge_already_initialized" }),
                ),
                false,
            ),
            "hello" => match bind_hook_bridge(&frame.payload) {
                Ok(binding) => {
                    let namespace = binding.namespace.clone();
                    let remote_machine_id = binding.remote_machine_id.clone();
                    hook_binding = Some(binding);
                    (
                        response(
                            request_id,
                            "helloOk",
                            json!({
                                "protocolMajor": PROTOCOL_MAJOR,
                                "protocolMinor": PROTOCOL_MINOR,
                                "capabilities": capabilities(),
                                "hookNamespace": namespace,
                                "remoteMachineId": remote_machine_id,
                            }),
                        ),
                        false,
                    )
                }
                Err(code) => (
                    response(request_id, "error", json!({ "code": code })),
                    false,
                ),
            },
            "hookDrain" => {
                let Some(binding) = hook_binding.as_ref() else {
                    let response = response(
                        request_id,
                        "error",
                        json!({ "code": "bridge_not_initialized" }),
                    );
                    write_frame(writer, &response)?;
                    continue;
                };
                drain_hook_notifications(binding);
                let after_sequence = frame
                    .payload
                    .get("afterSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let limit = frame
                    .payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(128) as usize;
                let layout = resolve_layout().map_err(str::to_string)?;
                let wait_ms = frame
                    .payload
                    .get("waitMs")
                    .and_then(Value::as_u64)
                    .unwrap_or_default()
                    .min(5_000);
                let mut batch =
                    read_spool_batch(&layout.state_dir, &binding.namespace, after_sequence, limit);
                if batch.as_ref().is_ok_and(|events| events.is_empty()) && wait_ms > 0 {
                    wait_for_hook_notification(binding, std::time::Duration::from_millis(wait_ms));
                    batch = read_spool_batch(
                        &layout.state_dir,
                        &binding.namespace,
                        after_sequence,
                        limit,
                    );
                }
                match batch {
                    Ok(events) => {
                        let latest_sequence = events
                            .iter()
                            .filter_map(|event| event.get("sequence").and_then(Value::as_u64))
                            .max()
                            .unwrap_or(after_sequence);
                        (
                            response(
                                request_id,
                                "hookBatch",
                                json!({
                                    "events": events,
                                    "latestSequence": latest_sequence,
                                }),
                            ),
                            false,
                        )
                    }
                    Err(code) => (
                        response(request_id, "error", json!({ "code": code })),
                        false,
                    ),
                }
            }
            "cancel" => {
                let target = frame
                    .payload
                    .get("requestId")
                    .and_then(Value::as_str)
                    .filter(|value| valid_request_id(value) && *value != request_id);
                match target {
                    Some(target) => {
                        let accepted = cancelled_requests.insert(target);
                        (
                            response(
                                request_id,
                                "response",
                                json!({ "accepted": accepted, "requestId": target }),
                            ),
                            false,
                        )
                    }
                    None => (
                        response(
                            request_id,
                            "error",
                            json!({ "code": "cancel_request_invalid" }),
                        ),
                        false,
                    ),
                }
            }
            "hookAck" => {
                let Some(binding) = hook_binding.as_ref() else {
                    let response = response(
                        request_id,
                        "error",
                        json!({ "code": "bridge_not_initialized" }),
                    );
                    write_frame(writer, &response)?;
                    continue;
                };
                let Some(through_sequence) =
                    frame.payload.get("throughSequence").and_then(Value::as_u64)
                else {
                    let response = response(
                        request_id,
                        "error",
                        json!({ "code": "hook_ack_sequence_invalid" }),
                    );
                    write_frame(writer, &response)?;
                    continue;
                };
                let layout = resolve_layout().map_err(str::to_string)?;
                match ack_spool(&layout.state_dir, &binding.namespace, through_sequence) {
                    Ok(()) => (
                        response(
                            request_id,
                            "response",
                            json!({ "accepted": true, "throughSequence": through_sequence }),
                        ),
                        false,
                    ),
                    Err(code) => (
                        response(request_id, "error", json!({ "code": code })),
                        false,
                    ),
                }
            }
            "historySync" => match serde_json::from_value::<HistoryScopeRequest>(frame.payload) {
                Ok(request) => match crate::history::sync(request) {
                    Ok(result) => (
                        response(
                            request_id,
                            "response",
                            serde_json::to_value(result).unwrap_or(Value::Null),
                        ),
                        false,
                    ),
                    Err(code) => (
                        response(request_id, "error", json!({ "code": code })),
                        false,
                    ),
                },
                Err(_) => (
                    response(
                        request_id,
                        "error",
                        json!({ "code": "history_request_invalid" }),
                    ),
                    false,
                ),
            },
            "historySearch" => {
                match serde_json::from_value::<HistorySearchRequest>(frame.payload) {
                    Ok(request) => match crate::history::search(request) {
                        Ok(result) => (
                            response(request_id, "response", json!({ "hits": result })),
                            false,
                        ),
                        Err(code) => (
                            response(request_id, "error", json!({ "code": code })),
                            false,
                        ),
                    },
                    Err(_) => (
                        response(
                            request_id,
                            "error",
                            json!({ "code": "history_request_invalid" }),
                        ),
                        false,
                    ),
                }
            }
            _ => handle_frame(frame),
        };
        write_frame(writer, &response)?;
        if shutdown {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        handle_frame, read_frame, run_bridge, write_frame, write_history_detail_chunks,
        CancelledRequests, ClientFrame, ServerFrame, MAX_CANCELLED_REQUESTS, MAX_FRAME_BYTES,
    };
    use base64::{engine::general_purpose, Engine as _};
    use serde_json::json;
    use std::io::Cursor;

    // 为测试客户端帧编码 JSON 与四字节大端长度，不应用生产长度限制。
    fn encoded_client_frame(frame: &ClientFrame) -> Vec<u8> {
        let payload = serde_json::to_vec(frame).unwrap();
        let mut bytes = Vec::with_capacity(payload.len() + 4);
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&payload);
        bytes
    }

    // 跳过测试输出的单行前导，依长度顺序解码所有服务端帧；畸形输出令测试失败。
    fn decoded_server_frames(output: &[u8]) -> Vec<ServerFrame> {
        let preamble_end = output.iter().position(|byte| *byte == b'\n').unwrap() + 1;
        let mut reader = Cursor::new(&output[preamble_end..]);
        let mut frames = Vec::new();
        while (reader.position() as usize) < output.len() - preamble_end {
            let mut length = [0u8; 4];
            std::io::Read::read_exact(&mut reader, &mut length).unwrap();
            let mut payload = vec![0; u32::from_be_bytes(length) as usize];
            std::io::Read::read_exact(&mut reader, &mut payload).unwrap();
            frames.push(serde_json::from_slice(&payload).unwrap());
        }
        frames
    }

    impl serde::Serialize for ClientFrame {
        // 仅在测试中按 requestId、kind、payload 字段序列化客户端帧，保持生产接收格式。
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            use serde::ser::SerializeStruct;
            let mut state = serializer.serialize_struct("ClientFrame", 3)?;
            state.serialize_field("requestId", &self.request_id)?;
            state.serialize_field("kind", &self.kind)?;
            state.serialize_field("payload", &self.payload)?;
            state.end()
        }
    }

    #[test]
    // 验证无状态 ping 返回 pong 并保留载荷，不触发关闭。
    fn ping_round_trips_payload() {
        let (frame, shutdown) = handle_frame(ClientFrame {
            request_id: "request-1".into(),
            kind: "ping".into(),
            payload: json!({ "sentAt": 42 }),
        });
        assert!(!shutdown);
        assert_eq!(frame.kind, "pong");
        assert_eq!(frame.payload["sentAt"], 42);
    }

    #[test]
    // 验证 hello 能力列表包含约定名称；只检查能力声明，不证明每项运行时保证。
    fn generic_capabilities_advertise_runtime_guards() {
        let (frame, shutdown) = handle_frame(ClientFrame {
            request_id: "hello".into(),
            kind: "hello".into(),
            payload: json!({}),
        });
        assert!(!shutdown);
        for capability in [
            "bridgeProtocol",
            "hookSpool",
            "heartbeat",
            "requestCancellation",
            "agentCapabilitiesV1",
            "boundedBackpressure",
            "historyDetailChunks",
            "historyResumePreflight",
            "fileList",
            "fileRead",
            "fileSearch",
            "fileGet",
            "fileDelete",
            "fileAttach",
            "fileAttachAny",
            "fileAttachCustomRoot",
            "fileAttachmentRoot",
            "filePut",
            "gitListRepositories",
            "gitChanges",
            "gitDiff",
            "gitDiffOptions",
            "gitHistory",
            "gitBranchStatus",
            "gitBranches",
            "gitOperationContinue",
            "gitOperationAbort",
            "gitWorkspaceTools",
            "gitFull",
        ] {
            assert!(frame.payload["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value.as_str() == Some(capability)));
        }
    }

    #[test]
    // 用内存帧验证 bridge 输出精确前导，并在 shutdown 时返回 accepted 响应。
    fn bridge_writes_preamble_and_shutdown_response() {
        let input = encoded_client_frame(&ClientFrame {
            request_id: "request-2".into(),
            kind: "shutdown".into(),
            payload: json!({}),
        });
        let mut reader = Cursor::new(input);
        let mut output = Vec::new();
        run_bridge(&mut reader, &mut output, "nonce-1").unwrap();
        let preamble_end = output.iter().position(|byte| *byte == b'\n').unwrap() + 1;
        assert_eq!(
            &output[..preamble_end],
            b"CLI_MANAGER_SSH_AGENT/1 nonce-1\n"
        );
        let mut frame_reader = Cursor::new(&output[preamble_end..]);
        let mut length = [0u8; 4];
        std::io::Read::read_exact(&mut frame_reader, &mut length).unwrap();
        let mut payload = vec![0; u32::from_be_bytes(length) as usize];
        std::io::Read::read_exact(&mut frame_reader, &mut payload).unwrap();
        let response: ServerFrame = serde_json::from_slice(&payload).unwrap();
        assert_eq!(response.kind, "response");
        assert_eq!(response.payload["accepted"], true);
    }

    #[test]
    // 验证缺少必需字段的恢复预检请求返回结构错误，并可继续处理 shutdown。
    fn resume_preflight_rejects_unstructured_requests() {
        let mut input = encoded_client_frame(&ClientFrame {
            request_id: "resume-1".into(),
            kind: "historyResumePreflight".into(),
            payload: json!({}),
        });
        input.extend(encoded_client_frame(&ClientFrame {
            request_id: "shutdown-1".into(),
            kind: "shutdown".into(),
            payload: json!({}),
        }));
        let mut output = Vec::new();
        run_bridge(&mut Cursor::new(input), &mut output, "nonce-1").unwrap();
        let frames = decoded_server_frames(&output);
        assert_eq!(frames[0].kind, "error");
        assert_eq!(frames[0].payload["code"], "history_resume_request_invalid");
    }

    #[test]
    // 在内存输入中先取消再提交目标 ping，验证目标被拒绝且后续 shutdown 正常响应。
    fn cancel_is_bounded_and_rejects_the_target_request() {
        let mut input = encoded_client_frame(&ClientFrame {
            request_id: "cancel-1".into(),
            kind: "cancel".into(),
            payload: json!({ "requestId": "target-1" }),
        });
        input.extend(encoded_client_frame(&ClientFrame {
            request_id: "target-1".into(),
            kind: "ping".into(),
            payload: json!({ "sentAt": 1 }),
        }));
        input.extend(encoded_client_frame(&ClientFrame {
            request_id: "shutdown-1".into(),
            kind: "shutdown".into(),
            payload: json!({}),
        }));
        let mut output = Vec::new();
        run_bridge(&mut Cursor::new(input), &mut output, "nonce-1").unwrap();
        let frames = decoded_server_frames(&output);
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].kind, "response");
        assert_eq!(frames[0].payload["accepted"], true);
        assert_eq!(frames[1].kind, "error");
        assert_eq!(frames[1].payload["code"], "request_cancelled");
        assert_eq!(frames[2].kind, "response");
    }

    #[test]
    // 验证取消标记被消费后重新加入，不会因旧队列条目在容量边界被提前淘汰。
    fn consumed_cancel_id_can_be_reinserted_without_stale_eviction() {
        let mut cancelled = CancelledRequests::default();
        assert!(cancelled.insert("target"));
        assert!(cancelled.take("target"));
        assert!(cancelled.insert("target"));
        for index in 0..MAX_CANCELLED_REQUESTS - 1 {
            assert!(cancelled.insert(&format!("other-{index}")));
        }
        assert!(cancelled.take("target"));
    }

    #[test]
    // 仅提供超限长度前缀，验证读取器在分配载荷前拒绝该帧。
    fn oversized_frame_is_rejected() {
        let mut input = Cursor::new(((super::MAX_FRAME_BYTES as u32) + 1).to_be_bytes().to_vec());
        assert_eq!(read_frame(&mut input).unwrap_err(), "frame_size_invalid");
    }

    #[test]
    // 验证 512 KiB 附件块经 Base64 和 JSON 包装后仍不超过单帧上限。
    fn maximum_attachment_chunk_fits_the_bridge_frame() {
        let frame = ClientFrame {
            request_id: "attachment-1".into(),
            kind: "fileAttachChunk".into(),
            payload: json!({
                "uploadId": "00000000-0000-4000-8000-000000000001",
                "offset": 0,
                "dataBase64": general_purpose::STANDARD.encode(vec![0u8; 512 * 1024]),
            }),
        };
        assert!(serde_json::to_vec(&frame).unwrap().len() <= MAX_FRAME_BYTES);
    }

    #[test]
    // 验证空输入正常结束，而不足四字节的长度前缀产生读取错误。
    fn clean_eof_and_truncated_length_are_distinct() {
        assert!(read_frame(&mut Cursor::new(Vec::<u8>::new()))
            .unwrap()
            .is_none());
        let error = read_frame(&mut Cursor::new(vec![0, 0])).unwrap_err();
        assert!(error.starts_with("frame_length_read_failed:"));
    }

    #[test]
    // 验证服务端帧的大端长度前缀等于实际 JSON 载荷字节数。
    fn server_frame_uses_length_prefix() {
        let mut output = Vec::new();
        write_frame(
            &mut output,
            &ServerFrame {
                request_id: "request-3".into(),
                kind: "pong".into(),
                payload: json!({}),
            },
        )
        .unwrap();
        let length = u32::from_be_bytes(output[..4].try_into().unwrap()) as usize;
        assert_eq!(length, output.len() - 4);
    }

    #[test]
    // 用含引号、反斜杠和中文的大文本验证分片帧大小、索引、总数及无损重组。
    fn history_detail_chunks_round_trip_above_the_frame_limit() {
        let serialized = serde_json::to_string(&json!({
            "messages": [{ "content": "\\\"中".repeat(MAX_FRAME_BYTES) }]
        }))
        .unwrap();
        let mut output = Vec::new();
        write_history_detail_chunks(&mut output, "history-1", &serialized).unwrap();

        let mut reader = Cursor::new(output);
        let mut rebuilt = String::new();
        let mut expected_index = 0usize;
        let mut total = None;
        while (reader.position() as usize) < reader.get_ref().len() {
            let mut length = [0u8; 4];
            std::io::Read::read_exact(&mut reader, &mut length).unwrap();
            let length = u32::from_be_bytes(length) as usize;
            assert!(length <= MAX_FRAME_BYTES);
            let mut payload = vec![0; length];
            std::io::Read::read_exact(&mut reader, &mut payload).unwrap();
            let frame: ServerFrame = serde_json::from_slice(&payload).unwrap();
            assert_eq!(frame.request_id, "history-1");
            assert_eq!(frame.kind, "historyDetailChunk");
            assert_eq!(frame.payload["index"], expected_index);
            let frame_total = frame.payload["total"].as_u64().unwrap() as usize;
            assert_eq!(*total.get_or_insert(frame_total), frame_total);
            rebuilt.push_str(frame.payload["data"].as_str().unwrap());
            expected_index += 1;
        }
        assert_eq!(Some(expected_index), total);
        assert_eq!(rebuilt, serialized);
    }
}
