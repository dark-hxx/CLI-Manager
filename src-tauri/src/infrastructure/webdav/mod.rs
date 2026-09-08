use crate::provider::network_client;
use log::{debug, error};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{header, Client, Method, Response};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebDavError {
    pub message: String,
    pub status_code: Option<u16>,
}

impl std::fmt::Display for WebDavError {
    // 只输出错误消息正文，HTTP 状态码仍保留在结构字段中。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for WebDavError {}

const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

pub struct WebDavClient {
    client: Client,
    config: WebDavConfig,
    auth_header: String,
}

impl WebDavClient {
    // 取得当前共享网络客户端，并将配置中的用户名和密码编码为缓存的 Basic 认证头。
    pub fn new(config: WebDavConfig) -> Self {
        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            format!("{}:{}", config.username, config.password),
        );
        let auth_header = format!("Basic {encoded}");
        Self {
            client: network_client::current_client(),
            config,
            auth_header,
        }
    }

    // 借用缓存的 Basic 认证头；其中包含可解码的凭据，不应写入日志。
    fn auth_header(&self) -> &str {
        &self.auth_header
    }

    // 拒绝非成功 HTTP 状态；成功响应先检查声明长度，再完整读取并检查 16 MiB 上限。
    // 未声明长度的响应仍会先整体分配内存，末尾大小检查并非流式内存上限。
    async fn handle_response(response: Response) -> Result<Vec<u8>, WebDavError> {
        let status = response.status();
        if status.is_success() {
            if let Some(len) = response.content_length() {
                if len > MAX_RESPONSE_BYTES {
                    return Err(WebDavError {
                        message: format!("Response too large: {} bytes", len),
                        status_code: Some(status.as_u16()),
                    });
                }
            }
            let bytes = response.bytes().await.map_err(|e| WebDavError {
                message: format!("Failed to read response: {}", e),
                status_code: None,
            })?;
            if bytes.len() > MAX_RESPONSE_BYTES as usize {
                return Err(WebDavError {
                    message: format!("Response too large: {} bytes", bytes.len()),
                    status_code: Some(status.as_u16()),
                });
            }
            Ok(bytes.to_vec())
        } else {
            Err(WebDavError {
                message: format!("HTTP error: {}", status),
                status_code: Some(status.as_u16()),
            })
        }
    }

    // 向基础 URL 发送带认证的 OPTIONS，只以 HTTP 成功状态判断连接测试结果，不验证 DAV 能力。
    pub async fn test_connection(&self) -> Result<bool, WebDavError> {
        let url = self.config.url.trim_end_matches('/');

        let response = self
            .client
            .request(Method::OPTIONS, url)
            .header(header::AUTHORIZATION, self.auth_header())
            .send()
            .await
            .map_err(|e| WebDavError {
                message: format!("Connection failed: {}", e),
                status_code: None,
            })?;

        Ok(response.status().is_success())
    }

    // 拼接远端路径并发出 HEAD；任意非成功 HTTP 状态均返回 false，不区分不存在与权限失败。
    pub async fn exists(&self, remote_path: &str) -> Result<bool, WebDavError> {
        let url = format!(
            "{}/{}",
            self.config.url.trim_end_matches('/'),
            remote_path.trim_start_matches('/')
        );

        let response = self
            .client
            .head(&url)
            .header(header::AUTHORIZATION, self.auth_header())
            .send()
            .await
            .map_err(|e| WebDavError {
                message: format!("HEAD request failed: {}", e),
                status_code: None,
            })?;

        Ok(response.status().is_success())
    }

    // 拼接 URL 后发送认证 GET，经统一响应处理返回字节；路径授权与备份文件名校验由上层负责。
    pub async fn download(&self, remote_path: &str) -> Result<Vec<u8>, WebDavError> {
        let url = format!(
            "{}/{}",
            self.config.url.trim_end_matches('/'),
            remote_path.trim_start_matches('/')
        );

        let response = self
            .client
            .get(&url)
            .header(header::AUTHORIZATION, self.auth_header())
            .send()
            .await
            .map_err(|e| WebDavError {
                message: format!("GET request failed: {}", e),
                status_code: None,
            })?;

        Self::handle_response(response).await
    }

    // 以 application/json PUT 上传完整字节并记录 URL 和长度；上传成功后仍会读取和校验响应体。
    pub async fn upload(&self, remote_path: &str, data: Vec<u8>) -> Result<(), WebDavError> {
        let url = format!(
            "{}/{}",
            self.config.url.trim_end_matches('/'),
            remote_path.trim_start_matches('/')
        );

        debug!("Uploading to WebDAV: {} ({} bytes)", url, data.len());

        let response = self
            .client
            .put(&url)
            .header(header::AUTHORIZATION, self.auth_header())
            .header(header::CONTENT_TYPE, "application/json")
            .body(data)
            .send()
            .await
            .map_err(|e| {
                error!("PUT request failed: {}", e);
                WebDavError {
                    message: format!("PUT request failed: {}", e),
                    status_code: None,
                }
            })?;

        let status = response.status();
        debug!("Upload response status: {}", status);

        Self::handle_response(response).await?;
        Ok(())
    }

    // 发送 Depth: 1 的 PROPFIND 并收集 XML href 文本；不在此过滤目录自身、解码 URL 或验证备份路径。
    pub async fn list(&self, remote_path: &str) -> Result<Vec<String>, WebDavError> {
        let url = format!(
            "{}/{}",
            self.config.url.trim_end_matches('/'),
            remote_path.trim_start_matches('/')
        );
        let response = self
            .client
            .request(Method::from_bytes(b"PROPFIND").expect("valid WebDAV method"), &url)
            .header(header::AUTHORIZATION, self.auth_header())
            .header("Depth", "1")
            .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
            .body(r#"<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>"#)
            .send()
            .await
            .map_err(|e| WebDavError {
                message: format!("PROPFIND request failed: {}", e),
                status_code: None,
            })?;
        let bytes = Self::handle_response(response).await?;
        let mut reader = Reader::from_reader(bytes.as_slice());
        reader.config_mut().trim_text(true);
        let mut paths = Vec::new();
        let mut in_href = false;
        loop {
            match reader.read_event() {
                Ok(Event::Start(event)) if event.local_name().as_ref() == b"href" => in_href = true,
                Ok(Event::Text(text)) if in_href => {
                    let value = text.decode().map_err(|e| WebDavError {
                        message: format!("Failed to parse PROPFIND response: {}", e),
                        status_code: None,
                    })?;
                    paths.push(value.into_owned());
                }
                Ok(Event::End(event)) if event.local_name().as_ref() == b"href" => in_href = false,
                Ok(Event::Eof) => break,
                Err(e) => {
                    return Err(WebDavError {
                        message: format!("Failed to parse PROPFIND response: {}", e),
                        status_code: None,
                    })
                }
                _ => {}
            }
        }
        Ok(paths)
    }

    // 向拼接后的 URL 发送认证 DELETE，再检查响应体；响应读取失败不代表远端删除未发生。
    pub async fn delete(&self, remote_path: &str) -> Result<(), WebDavError> {
        let url = format!(
            "{}/{}",
            self.config.url.trim_end_matches('/'),
            remote_path.trim_start_matches('/')
        );
        let response = self
            .client
            .delete(&url)
            .header(header::AUTHORIZATION, self.auth_header())
            .send()
            .await
            .map_err(|e| WebDavError {
                message: format!("DELETE request failed: {}", e),
                status_code: None,
            })?;
        Self::handle_response(response).await?;
        Ok(())
    }

    // 发送 MKCOL 创建集合，将成功状态或 405 视为成功；不会额外确认 405 对应的资源类型。
    pub async fn mkdir(&self, remote_path: &str) -> Result<(), WebDavError> {
        let url = format!(
            "{}/{}",
            self.config.url.trim_end_matches('/'),
            remote_path.trim_start_matches('/')
        );

        debug!("Creating WebDAV directory: {}", url);

        let response = self
            .client
            .request(Method::from_bytes(b"MKCOL").unwrap(), &url)
            .header(header::AUTHORIZATION, self.auth_header())
            .send()
            .await
            .map_err(|e| {
                error!("MKCOL request failed: {}", e);
                WebDavError {
                    message: format!("MKCOL request failed: {}", e),
                    status_code: None,
                }
            })?;

        let status = response.status();
        debug!("MKCOL response status: {}", status);

        if status.is_success() || status.as_u16() == 405 {
            debug!("Directory created or already exists");
            Ok(())
        } else {
            error!("Failed to create directory: {}", status);
            Err(WebDavError {
                message: format!("Failed to create directory: {}", status),
                status_code: Some(status.as_u16()),
            })
        }
    }

    // 先 HEAD 探测并尝试直接 MKCOL，只有 409 才逐级创建路径；中途失败不回滚已创建的父目录。
    pub async fn ensure_directory(&self, remote_path: &str) -> Result<(), WebDavError> {
        let path = remote_path.trim_matches('/');
        debug!("Ensuring directory path: {}", path);

        // Try to create the directory directly first
        // If it fails (parent doesn't exist), create parents recursively
        if self.exists(path).await? {
            debug!("Directory already exists: {}", path);
            return Ok(());
        }

        // Try direct MKCOL
        match self.mkdir(path).await {
            Ok(()) => {
                debug!("Directory created directly: {}", path);
                return Ok(());
            }
            Err(e) => {
                // If 409 Conflict, parent might not exist, try creating parents
                if e.status_code == Some(409) {
                    debug!("Parent directory may not exist, creating recursively");
                } else {
                    return Err(e);
                }
            }
        }

        // Create parent directories recursively
        let parts: Vec<&str> = path.split('/').collect();
        let mut current = String::new();

        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                current.push('/');
            }
            current.push_str(part);

            if !self.exists(&current).await? {
                debug!("Creating directory: {}", current);
                self.mkdir(&current).await?;
            }
        }

        Ok(())
    }
}
