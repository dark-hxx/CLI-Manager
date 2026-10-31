// SSH 代理命令的纯构造逻辑；可执行文件路径由宿主层注入。

/// 构造 OpenSSH ProxyCommand。
///
/// 显式 ProxyCommand 会原样保留；HTTP/SOCKS5 代理只生成不带凭据的
/// helper 命令，并保留 `%h`/`%p` 交由 OpenSSH 替换。
pub fn build_proxy_command(
    proxy_type: &str,
    proxy_host: &str,
    proxy_port: u16,
    legacy_command: &str,
    executable: Option<&str>,
) -> Result<String, String> {
    match proxy_type.trim() {
        "" if !legacy_command.trim().is_empty() => Ok(legacy_command.trim().to_string()),
        "" | "none" => Ok(String::new()),
        "proxy_command" => {
            if legacy_command.trim().is_empty() {
                Err("ssh_proxy_command_required".to_string())
            } else {
                Ok(legacy_command.trim().to_string())
            }
        }
        proxy_kind @ ("http" | "socks5") => {
            let host = proxy_host.trim();
            if host.contains('@') {
                return Err("ssh_proxy_credentials_forbidden".to_string());
            }
            if host.is_empty()
                || proxy_port == 0
                || !host.chars().all(|ch| {
                    ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '%')
                })
            {
                return Err("ssh_proxy_address_invalid".to_string());
            }
            let executable =
                executable.ok_or_else(|| "ssh_proxy_helper_unavailable".to_string())?;
            if executable.contains('"') {
                return Err("ssh_proxy_helper_unavailable".to_string());
            }
            Ok(format!(
                "\"{executable}\" __ssh_proxy --type {proxy_kind} --proxy-host {host} --proxy-port {proxy_port} --target-host %h --target-port %p"
            ))
        }
        _ => Err("ssh_proxy_type_invalid".to_string()),
    }
}

use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream};

const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;

/// 完成 HTTP CONNECT 或无认证 SOCKS5 握手，返回握手期间多读到的 HTTP 负载。
pub fn handshake_proxy(
    stream: &mut TcpStream,
    proxy_type: &str,
    target_host: &str,
    target_port: u16,
) -> Result<Vec<u8>, String> {
    match proxy_type {
        "http" => connect_http(stream, target_host, target_port),
        "socks5" => {
            connect_socks5(stream, target_host, target_port)?;
            Ok(Vec::new())
        }
        _ => Err("ssh_proxy_type_invalid".to_string()),
    }
}

fn connect_http(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
) -> Result<Vec<u8>, String> {
    let authority = format_authority(target_host, target_port);
    let request = format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: Keep-Alive\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("proxy_handshake_failed: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("proxy_handshake_failed: {error}"))?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 1024];
    let header_end = loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("proxy_handshake_failed: {error}"))?;
        if read == 0 {
            return Err("proxy_handshake_closed".to_string());
        }
        response.extend_from_slice(&chunk[..read]);
        if response.len() > MAX_HTTP_HEADER_BYTES {
            return Err("proxy_response_too_large".to_string());
        }
        if let Some(index) = find_header_end(&response) {
            break index;
        }
    };

    let header = String::from_utf8_lossy(&response[..header_end]);
    let status = header.lines().next().unwrap_or_default();
    if !status
        .split_whitespace()
        .nth(1)
        .is_some_and(|code| code == "200")
    {
        return Err(format!("proxy_http_connect_rejected: {status}"));
    }
    Ok(response[header_end..].to_vec())
}

fn connect_socks5(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
) -> Result<(), String> {
    stream
        .write_all(&[0x05, 0x01, 0x00])
        .map_err(|error| format!("proxy_handshake_failed: {error}"))?;
    let mut method = [0_u8; 2];
    stream
        .read_exact(&mut method)
        .map_err(|error| format!("proxy_handshake_failed: {error}"))?;
    if method != [0x05, 0x00] {
        return Err("proxy_socks5_auth_unsupported".to_string());
    }

    let mut request = vec![0x05, 0x01, 0x00];
    match target_host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            request.push(0x01);
            request.extend_from_slice(&address.octets());
        }
        Ok(IpAddr::V6(address)) => {
            request.push(0x04);
            request.extend_from_slice(&address.octets());
        }
        Err(_) => {
            let host = target_host.as_bytes();
            if host.is_empty() || host.len() > u8::MAX as usize {
                return Err("ssh_proxy_target_invalid".to_string());
            }
            request.push(0x03);
            request.push(host.len() as u8);
            request.extend_from_slice(host);
        }
    }
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .map_err(|error| format!("proxy_handshake_failed: {error}"))?;

    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("proxy_handshake_failed: {error}"))?;
    if header[0] != 0x05 || header[1] != 0x00 {
        return Err(format!("proxy_socks5_connect_rejected: {}", header[1]));
    }
    let address_len = match header[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .map_err(|error| format!("proxy_handshake_failed: {error}"))?;
            length[0] as usize
        }
        _ => return Err("proxy_socks5_response_invalid".to_string()),
    };
    let mut ignored = vec![0_u8; address_len + 2];
    stream
        .read_exact(&mut ignored)
        .map_err(|error| format!("proxy_handshake_failed: {error}"))?;
    Ok(())
}

fn format_authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn find_header_end(value: &[u8]) -> Option<usize> {
    value
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

#[cfg(test)]
mod tests {
    use super::build_proxy_command;

    #[test]
    fn keeps_explicit_commands_and_builds_helper_commands() {
        assert_eq!(
            build_proxy_command("", "", 0, "nc %h %p", None).unwrap(),
            "nc %h %p"
        );
        assert_eq!(
            build_proxy_command("http", "127.0.0.1", 8080, "", Some("C:/cli.exe")).unwrap(),
            "\"C:/cli.exe\" __ssh_proxy --type http --proxy-host 127.0.0.1 --proxy-port 8080 --target-host %h --target-port %p"
        );
    }

    #[test]
    fn rejects_credentials_invalid_addresses_and_missing_executable() {
        assert_eq!(
            build_proxy_command("http", "user@proxy", 8080, "", Some("cli.exe")),
            Err("ssh_proxy_credentials_forbidden".to_string())
        );
        assert_eq!(
            build_proxy_command("socks5", "bad host", 1080, "", Some("cli.exe")),
            Err("ssh_proxy_address_invalid".to_string())
        );
        assert_eq!(
            build_proxy_command("http", "127.0.0.1", 8080, "", None),
            Err("ssh_proxy_helper_unavailable".to_string())
        );
    }
}
