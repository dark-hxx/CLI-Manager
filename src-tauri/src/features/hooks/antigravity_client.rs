use cli_manager_hook_schema::antigravity::{
    observation, passive_response, valid_distro, valid_tab_id,
};
use serde_json::json;
use std::io::{Read, Write};

// 只信任宿主 PTY 的成套回调参数。未启用时连 stdin 都不解析，不查发现文件或诊断日志。
fn deliver(
    event: &str,
    expected_distro: Option<&str>,
    stdin: impl Read,
    env: impl Fn(&str) -> Option<String>,
    send: impl FnOnce(&str, &str, &[u8]),
) -> Option<()> {
    if env("CLI_MANAGER_AGY_HOOK_ENABLED").as_deref() != Some("1") {
        return None;
    }
    let tab = env("CLI_MANAGER_TAB_ID")?;
    let token = env("CLI_MANAGER_NOTIFY_TOKEN")?;
    let port = env("CLI_MANAGER_NOTIFY_PORT")?.parse::<u16>().ok()?;
    let distro = env("WSL_DISTRO_NAME");
    // guest 变量丢失或串 distro 时宁可没有状态，也不能降级为宿主的会话。
    if !match (expected_distro, distro.as_deref()) {
        (None, None) => true,
        (Some(target), Some(actual)) => valid_distro(target) && target.eq_ignore_ascii_case(actual),
        _ => false,
    } {
        return None;
    }
    if !valid_tab_id(&tab)
        || port == 0
        || token.is_empty()
        || token.len() > 512
        || !token.bytes().all(|b| b.is_ascii_graphic())
        || distro.as_deref().is_some_and(|d| !valid_distro(d))
    {
        return None;
    }
    let at = chrono::Utc::now().to_rfc3339();
    let (kind, session) = observation(event, stdin)?;
    let body = serde_json::to_vec(&json!({ "source": "antigravity", "event": kind,
        "tabId": tab, "sessionId": session, "timestamp": at, "wslDistroName": distro }))
    .ok()?;
    send(&port.to_string(), &token, &body);
    Some(())
}

// 先写并刷新原生活动所需的无干预响应，离线、超限或坏输入都走同一 stdout/exit 0。
pub(super) fn run(event: &str) -> ! {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(passive_response(event));
    let _ = stdout.flush();
    drop(stdout);
    // 整个 stdin/loopback 都在同一短预算内；对端卡住也不等 agy 的 5 秒 hook 超时。
    let event = event.to_owned();
    let mut scope_args = std::env::args_os().skip_while(|arg| arg != "--agy-wsl-distro");
    // 选项存在但值丢失时保留无效哨兵，不能将受限的 WSL 回调视为原生回调。
    let expected_distro = scope_args.next().map(|_| {
        scope_args
            .next()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    let (done, recv) = std::sync::mpsc::channel();
    if std::thread::Builder::new()
        .spawn(move || {
            let _ = deliver(
                &event,
                expected_distro.as_deref(),
                std::io::stdin().lock(),
                |key| std::env::var(key).ok(),
                |port, token, body| {
                    let _ = super::post(port, token, body);
                },
            );
            let _ = done.send(());
        })
        .is_ok()
    {
        let _ = recv.recv_timeout(std::time::Duration::from_millis(800));
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    const TAB: &str = "39c6b972-c888-42c0-a739-cbabc32969ac";
    const ID: &str = "ec33ebf9-0cba-4100-8142-c61503f6c587";

    #[test]
    fn antigravity_callback_is_minimal_authenticated_and_scoped() {
        let mut env = HashMap::from([
            ("CLI_MANAGER_AGY_HOOK_ENABLED", "1"),
            ("CLI_MANAGER_NOTIFY_PORT", "3164"),
            ("CLI_MANAGER_NOTIFY_TOKEN", "test-token"),
            ("CLI_MANAGER_TAB_ID", TAB),
        ]);
        let input=json!({"conversationId":ID,"fullyIdle":true,"terminationReason":"model_stop","error":"不应离开子进程", "lastUserInput":"private prompt", "toolCall":{"args":"secret"}}).to_string();
        for (target, actual, send_ok) in [
            (None, None, true),
            (Some("Distro-A"), Some("Distro-A"), true),
            (Some("Distro-A"), Some("Distro-B"), false),
            (Some("Distro-A"), None, false),
            (None, Some("Distro-A"), false),
        ] {
            if let Some(name) = actual {
                env.insert("WSL_DISTRO_NAME", name);
            } else {
                env.remove("WSL_DISTRO_NAME");
            }
            let mut count = 0;
            let got = deliver(
                "Stop",
                target,
                input.as_bytes(),
                |k| env.get(k).map(|v| v.to_string()),
                |port, token, body| {
                    count += 1;
                    assert_eq!((port, token), ("3164", "test-token"));
                    let mut v: Value = serde_json::from_slice(body).unwrap();
                    assert!(
                        chrono::DateTime::parse_from_rfc3339(v["timestamp"].as_str().unwrap())
                            .is_ok()
                    );
                    v.as_object_mut().unwrap().remove("timestamp");
                    assert_eq!(
                        v,
                        json!({"event":"StopFailure","source":"antigravity","sessionId":ID,"tabId":TAB,"wslDistroName":actual})
                    );
                },
            );
            assert_eq!(got.is_some(), send_ok);
            assert_eq!(count, usize::from(send_ok));
        }
        env.remove("WSL_DISTRO_NAME");
        for (key, val) in [
            ("CLI_MANAGER_AGY_HOOK_ENABLED", "0"),
            ("CLI_MANAGER_TAB_ID", "external:antigravity"),
            ("CLI_MANAGER_NOTIFY_PORT", "65536"),
            ("CLI_MANAGER_NOTIFY_TOKEN", "x\r\ny"),
        ] {
            let mut invalid = env.clone();
            invalid.insert(key, val);
            assert!(deliver(
                "Stop",
                None,
                input.as_bytes(),
                |k| invalid.get(k).map(|v| v.to_string()),
                |_, _, _| panic!("not managed")
            )
            .is_none());
            invalid.remove(key);
            assert!(deliver(
                "Stop",
                None,
                input.as_bytes(),
                |k| invalid.get(k).map(|v| v.to_string()),
                |_, _, _| panic!("missing env")
            )
            .is_none());
        }
        for (reason, expected_event) in [("NO_TOOL_CALL", "Stop"), ("USER_CANCELED", "Interrupt")] {
            let payload = json!({
                "conversationId": ID,
                "fullyIdle": true,
                "terminationReason": reason,
                "error": "",
                "transcriptPath": "",
                "hookEventName": ""
            })
            .to_string();
            let mut delivered = None;
            assert!(deliver(
                "Stop",
                None,
                payload.as_bytes(),
                |k| env.get(k).map(|v| v.to_string()),
                |_, _, body| {
                    let v: Value = serde_json::from_slice(body).unwrap();
                    delivered = v["event"].as_str().map(str::to_string);
                }
            )
            .is_some());
            assert_eq!(delivered.as_deref(), Some(expected_event));
        }
    }
}
