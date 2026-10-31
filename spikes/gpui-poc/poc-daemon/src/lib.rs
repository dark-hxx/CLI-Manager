//! Native transport experiment. Creates/closes only its own temporary session.
mod diagnostics;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    error::Error,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Result<T> = std::result::Result<T, Box<dyn Error>>;

async fn send(socket: &mut Socket, value: Value) -> Result<()> {
    timeout(
        Duration::from_secs(10),
        socket.send(Message::Text(value.to_string().into())),
    )
    .await??;
    Ok(())
}

async fn receive(socket: &mut Socket) -> Result<Message> {
    loop {
        let frame = timeout(Duration::from_secs(15), socket.next())
            .await?
            .ok_or("daemon disconnected")??;
        match frame {
            Message::Ping(data) => {
                socket.send(Message::Pong(data)).await?;
            }
            Message::Close(_) => return Err("daemon closed connection".into()),
            _ => return Ok(frame),
        }
    }
}

pub struct Output<'a> {
    pub kind: u8,
    pub cols: u16,
    pub rows: u16,
    session: &'a str,
    sequence: u64,
    pub data: &'a str,
}
fn decode(frame: &[u8]) -> Result<Output<'_>> {
    if frame.len() < 20
        || frame.len() > 8 * 1024 * 1024
        || frame[0] != 1
        || !matches!(frame[1], 1 | 2 | 5)
    {
        return Err("unsupported daemon binary frame".into());
    }
    let session_len = u16::from_be_bytes(frame[2..4].try_into()?) as usize;
    let data_len = u32::from_be_bytes(frame[16..20].try_into()?) as usize;
    if 20 + session_len + data_len != frame.len() {
        return Err("invalid binary length".into());
    }
    Ok(Output {
        kind: frame[1],
        cols: u16::from_be_bytes(frame[12..14].try_into()?),
        rows: u16::from_be_bytes(frame[14..16].try_into()?),
        session: std::str::from_utf8(&frame[20..20 + session_len])?,
        sequence: u64::from_be_bytes(frame[4..12].try_into()?),
        data: std::str::from_utf8(&frame[20 + session_len..])?,
    })
}

async fn wait_for(
    socket: &mut Socket,
    kind: &str,
    request_id: Option<u64>,
    session: &str,
    output: &mut String,
    consume: &mut impl FnMut(&Output<'_>),
) -> Result<Value> {
    let mut stats = diagnostics::Diagnostics::default();
    let result = timeout(Duration::from_secs(if kind == "marker" { 120 } else { 15 }), async {
        loop {
            match receive(socket).await? {
                Message::Text(text) => {
                    stats.control_frames += 1;
                    let value: Value = serde_json::from_str(&text)?;
                    if value["type"] == "ok" && value["id"] == 900 { stats.ack_replies += 1; }
                    if value["type"] == "err" || value["type"] == "auth_err" {
                        // Do not print raw server frames, tokens, or replay content.
                        return Err("daemon rejected PoC request".into());
                    }
                    if value["type"] == kind && request_id.is_none_or(|id| value["id"] == id) { return Ok(value); }
                }
                Message::Binary(bytes) => {
                    let frame = decode(&bytes)?;
                    if frame.session != session { return Err("unexpected session output".into()); }
                    stats.output(frame.sequence, frame.data.len());
                    let consumed = Instant::now();
                    consume(&frame);
                    stats.consume_ns += consumed.elapsed().as_nanos();
                    output.push_str(frame.data);
                    if output.len() > 16384 {
                        let mut keep = output.len() - 8192;
                        while !output.is_char_boundary(keep) { keep += 1; }
                        output.drain(..keep);
                    }
                    let sequence = frame.sequence;
                    let count = frame.data.encode_utf16().count();
                    let sent = Instant::now();
                    send(socket, json!({"type":"ack","id":900,"session_id":session,"sequence":sequence,"char_count":count})).await?;
                    let elapsed = sent.elapsed().as_nanos();
                    stats.ack_send_ns += elapsed;
                    stats.max_ack_send_ns = stats.max_ack_send_ns.max(elapsed);
                    if kind == "marker" && output.contains("NATIVE_POC_DONE") { return Ok(json!({"marker":true})); }
                }
                _ => {},
            }
        }
    }).await;
    if kind == "marker" {
        stats.report(!matches!(&result, Ok(Ok(_))));
    }
    result?
}

pub async fn probe(command: Option<&str>, mut consume: impl FnMut(&Output<'_>)) -> Result<()> {
    probe_with_nodelay(command, false, &mut consume).await
}

/// Diagnostic switch only: compare identical workloads without changing the daemon.
pub async fn probe_with_nodelay(command: Option<&str>, nodelay: bool, mut consume: impl FnMut(&Output<'_>)) -> Result<()> {
    let path = std::env::var_os("POC_DAEMON_DISCOVERY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("USERPROFILE").expect("USERPROFILE"))
                .join(".cli-manager/daemon.json")
        });
    let discovery: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let port = discovery["wsPort"]
        .as_u64()
        .filter(|p| (1..=65535).contains(p))
        .ok_or("missing wsPort")?;
    let token = discovery["token"].as_str().ok_or("missing auth token")?;
    let mut request = format!("ws://127.0.0.1:{port}/pty").into_client_request()?;
    request
        .headers_mut()
        .insert("Origin", "http://tauri.localhost".parse()?);
    let (mut socket, _) = timeout(Duration::from_secs(10), connect_async(request)).await??;
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        stream.set_nodelay(nodelay)?;
        println!("transport_tcp_nodelay={}", stream.nodelay()?);
    }
    send(
        &mut socket,
        json!({"type":"auth","token":token,"client_version":"1.4.4"}),
    )
    .await?;
    let mut output = String::new();
    let auth = wait_for(&mut socket, "auth_ok", None, "", &mut output, &mut consume).await?;
    if auth["binary_protocol_version"] != 1
        || !auth["features"]
            .as_array()
            .is_some_and(|features| features.iter().any(|f| f == "ws_binary_output_v1"))
    {
        return Err("daemon binary output feature unavailable".into());
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let session = format!("gpui-poc-{}-{nonce}", std::process::id());
    // Always attempt cleanup, including create response timeout after a successful server-side create.
    let exercise: Result<()> = async {
        send(&mut socket, json!({"type":"create","id":1,"session_id":session,"cwd":std::env::current_dir()?,"shell":"powershell"})).await?;
        wait_for(&mut socket, "created", Some(1), &session, &mut output, &mut consume).await?;
        send(&mut socket, json!({"type":"resize","id":2,"session_id":session,"cols":80,"rows":24})).await?;
        wait_for(&mut socket, "ok", Some(2), &session, &mut output, &mut consume).await?;
        send(&mut socket, json!({"type":"attach","id":3,"session_id":session,"after_sequence":0})).await?;
        wait_for(&mut socket, "attached", Some(3), &session, &mut output, &mut consume).await?;
        let command = command.unwrap_or("Write-Output ('NATIVE_POC_' + 'DONE')\r");
        send(&mut socket, json!({"type":"write","id":4,"session_id":session,"data":command})).await?;
        wait_for(&mut socket, "marker", None, &session, &mut output, &mut consume).await?;
        Ok(())
    }.await;
    let cleanup = async {
        send(
            &mut socket,
            json!({"type":"close","id":99,"session_id":session}),
        )
        .await?;
        wait_for(
            &mut socket,
            "ok",
            Some(99),
            &session,
            &mut output,
            &mut consume,
        )
        .await?;
        Ok::<_, Box<dyn Error>>(())
    }
    .await;
    exercise?;
    cleanup?;
    println!("native daemon smoke: auth/create/resize/attach/binary UTF-8/UTF-16 ACK/write/close passed; retained_tail_bytes={}", output.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_truncated_and_bad_utf8_frames() {
        assert!(decode(&[]).is_err());
        let mut bytes = vec![0; 21];
        bytes[0] = 1;
        bytes[1] = 1;
        bytes[19] = 1;
        bytes[20] = 0xff;
        assert!(decode(&bytes).is_err());
        bytes[20] = b'A';
        assert_eq!(decode(&bytes).unwrap().data, "A");
        bytes.push(0);
        assert!(decode(&bytes).is_err());
    }
}
