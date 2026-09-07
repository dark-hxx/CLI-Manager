use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, TcpStream, ToSocketAddrs};
use std::process;
use std::thread;
use std::time::Duration;

const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;

pub fn is_helper_request(args: &[String]) -> bool {
    args.get(1).map(String::as_str) == Some("__ssh_proxy")
}

pub fn build_proxy_command(
    proxy_type: &str,
    proxy_host: &str,
    proxy_port: u16,
    legacy_command: &str,
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
                std::env::current_exe().map_err(|_| "ssh_proxy_helper_unavailable".to_string())?;
            let executable = executable.to_string_lossy();
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

pub fn run_helper_and_exit(args: &[String]) -> ! {
    let result = (|| {
        let proxy_type = arg_value(args, "--type").ok_or("ssh_proxy_type_invalid")?;
        let proxy_host = arg_value(args, "--proxy-host").ok_or("ssh_proxy_address_invalid")?;
        let proxy_port = parse_port(args, "--proxy-port")?;
        let target_host = arg_value(args, "--target-host").ok_or("ssh_proxy_target_invalid")?;
        let target_port = parse_port(args, "--target-port")?;
        run_proxy(
            &proxy_type,
            &proxy_host,
            proxy_port,
            &target_host,
            target_port,
        )
    })();

    match result {
        Ok(()) => process::exit(0),
        Err(error) => {
            eprintln!("CLI-Manager SSH proxy error: {error}");
            process::exit(1);
        }
    }
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == key)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn parse_port(args: &[String], key: &str) -> Result<u16, String> {
    arg_value(args, key)
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| "ssh_proxy_address_invalid".to_string())
}

fn run_proxy(
    proxy_type: &str,
    proxy_host: &str,
    proxy_port: u16,
    target_host: &str,
    target_port: u16,
) -> Result<(), String> {
    let mut stream = connect_proxy_socket(proxy_host, proxy_port, Duration::from_secs(30))?;
    let initial_remote_bytes = handshake_proxy(&mut stream, proxy_type, target_host, target_port)?;
    bridge_stdio(stream, &initial_remote_bytes)
}

pub fn probe_proxy(
    proxy_type: &str,
    proxy_host: &str,
    proxy_port: u16,
    target_host: &str,
    target_port: u16,
    timeout: Duration,
) -> Result<(), String> {
    let mut stream = connect_proxy_socket(proxy_host, proxy_port, timeout)?;
    handshake_proxy(&mut stream, proxy_type, target_host, target_port)?;
    Ok(())
}

fn connect_proxy_socket(
    proxy_host: &str,
    proxy_port: u16,
    timeout: Duration,
) -> Result<TcpStream, String> {
    let addresses = (proxy_host, proxy_port)
        .to_socket_addrs()
        .map_err(|error| format!("proxy_dns_failed: {error}"))?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, timeout) {
            Ok(stream) => {
                stream
                    .set_nodelay(true)
                    .map_err(|error| format!("proxy_socket_failed: {error}"))?;
                stream
                    .set_read_timeout(Some(timeout))
                    .map_err(|error| format!("proxy_socket_failed: {error}"))?;
                stream
                    .set_write_timeout(Some(timeout))
                    .map_err(|error| format!("proxy_socket_failed: {error}"))?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "proxy_connect_failed: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no resolved address".to_string())
    ))
}

fn handshake_proxy(
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

fn bridge_stdio(stream: TcpStream, initial_remote_bytes: &[u8]) -> Result<(), String> {
    let mut reader = stream
        .try_clone()
        .map_err(|error| format!("proxy_socket_failed: {error}"))?;
    let mut writer = stream;
    let upload = thread::spawn(move || {
        let result = io::copy(&mut io::stdin().lock(), &mut writer);
        let _ = writer.shutdown(Shutdown::Write);
        result
    });

    let mut stdout = io::stdout().lock();
    stdout
        .write_all(initial_remote_bytes)
        .map_err(|error| format!("proxy_stdio_failed: {error}"))?;
    stdout
        .flush()
        .map_err(|error| format!("proxy_stdio_failed: {error}"))?;
    copy_with_flush(&mut reader, &mut stdout)
        .map_err(|error| format!("proxy_stdio_failed: {error}"))?;
    upload
        .join()
        .map_err(|_| "proxy_stdio_failed".to_string())?
        .map_err(|error| format!("proxy_stdio_failed: {error}"))?;
    Ok(())
}

fn copy_with_flush(reader: &mut impl Read, writer: &mut impl Write) -> io::Result<u64> {
    let mut buffer = [0_u8; 16 * 1024];
    let mut copied = 0_u64;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(copied),
            Ok(read) => {
                writer.write_all(&buffer[..read])?;
                writer.flush()?;
                copied += read as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
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
    use super::{build_proxy_command, copy_with_flush, is_helper_request, probe_proxy};
    use std::cell::Cell;
    use std::io::{self, Read, Write};
    use std::net::TcpListener;
    use std::rc::Rc;
    use std::thread;
    use std::time::Duration;

    struct FlushGatedReader {
        sent: bool,
        flushed: Rc<Cell<bool>>,
    }

    impl Read for FlushGatedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if !self.sent {
                self.sent = true;
                let packet = b"small-ssh-packet";
                buffer[..packet.len()].copy_from_slice(packet);
                return Ok(packet.len());
            }
            if self.flushed.get() {
                Ok(0)
            } else {
                Err(io::Error::other(
                    "packet was not flushed before the next read",
                ))
            }
        }
    }

    struct FlushTrackingWriter {
        bytes: Vec<u8>,
        flushed: Rc<Cell<bool>>,
    }

    impl Write for FlushTrackingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushed.set(true);
            Ok(())
        }
    }

    #[test]
    fn builds_native_http_and_socks_proxy_commands() {
        let http = build_proxy_command("http", "127.0.0.1", 8080, "").unwrap();
        assert!(http.contains("__ssh_proxy --type http"));
        assert!(http.contains("--target-host %h --target-port %p"));

        let socks = build_proxy_command("socks5", "::1", 1080, "").unwrap();
        assert!(socks.contains("__ssh_proxy --type socks5"));
    }

    #[test]
    fn detects_proxy_helper_before_inherited_askpass_environment_is_considered() {
        let args = vec!["cli-manager.exe".to_string(), "__ssh_proxy".to_string()];
        assert!(is_helper_request(&args));
    }

    #[test]
    fn flushes_each_remote_packet_before_waiting_for_more_data() {
        let flushed = Rc::new(Cell::new(false));
        let mut reader = FlushGatedReader {
            sent: false,
            flushed: Rc::clone(&flushed),
        };
        let mut writer = FlushTrackingWriter {
            bytes: Vec::new(),
            flushed,
        };

        assert_eq!(copy_with_flush(&mut reader, &mut writer).unwrap(), 16);
        assert_eq!(writer.bytes, b"small-ssh-packet");
    }

    #[test]
    fn rejects_invalid_proxy_addresses() {
        assert_eq!(
            build_proxy_command("socks5", "bad host", 1080, "").unwrap_err(),
            "ssh_proxy_address_invalid"
        );
        assert_eq!(
            build_proxy_command("http", "127.0.0.1", 0, "").unwrap_err(),
            "ssh_proxy_address_invalid"
        );
    }

    #[test]
    fn probes_http_connect_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 512];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("CONNECT example.com:22 HTTP/1.1"));
            stream
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
        });
        probe_proxy(
            "http",
            "127.0.0.1",
            address.port(),
            "example.com",
            22,
            Duration::from_secs(2),
        )
        .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn probes_socks5_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut greeting = [0_u8; 3];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [0x05, 0x01, 0x00]);
            stream.write_all(&[0x05, 0x00]).unwrap();

            let mut header = [0_u8; 5];
            stream.read_exact(&mut header).unwrap();
            assert_eq!(&header[..4], &[0x05, 0x01, 0x00, 0x03]);
            let mut target = vec![0_u8; header[4] as usize + 2];
            stream.read_exact(&mut target).unwrap();
            assert_eq!(&target[..header[4] as usize], b"example.com");
            stream
                .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .unwrap();
        });
        probe_proxy(
            "socks5",
            "127.0.0.1",
            address.port(),
            "example.com",
            22,
            Duration::from_secs(2),
        )
        .unwrap();
        server.join().unwrap();
    }
}
