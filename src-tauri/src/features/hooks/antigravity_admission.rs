//! agy 的协议窄于通用 Hook：认证后的 HTTP 也不允许多余字段；SSH spool 不在作用域内。
use super::ClaudeHookRequest;
use cli_manager_hook_schema::antigravity::{valid_distro, valid_session_id, valid_tab_id};
use serde::{de::IgnoredAny, Deserialize};
use std::collections::HashMap;

// 旧协议通常忽略未知字段；agy 必须对实际 wire 键名做白名单检查，值本身不保留。
pub(super) fn valid_fields(body: &[u8]) -> bool {
    #[derive(Deserialize, Eq, PartialEq, Hash)]
    #[serde(rename_all = "camelCase", field_identifier)]
    enum Field {
        Source,
        Event,
        TabId,
        SessionId,
        Timestamp,
        WslDistroName,
    }
    serde_json::from_slice::<HashMap<Field, IgnoredAny>>(body).is_ok()
}

// HTTP 已另查完整 wire；SSH spool 总会设置 environment_type，不能借用本机回调。
pub(super) fn valid_request(payload: &ClaudeHookRequest) -> bool {
    valid_tab_id(&payload.tab_id)
        && payload.session_id.as_deref().is_some_and(valid_session_id)
        && payload.wsl_distro_name.as_deref().is_none_or(valid_distro)
        && payload
            .timestamp
            .as_deref()
            .is_some_and(|t| chrono::DateTime::parse_from_rfc3339(t).is_ok())
        && matches!(
            payload.event.as_str(),
            "SessionStart" | "PreInvocation" | "Stop" | "StopFailure" | "Interrupt"
        )
        && payload.environment_type.is_none()
}

#[cfg(test)]
mod tests {
    use super::super::{
        handle_stream, remote_hook_payload_from_spool, ClaudeHookPayload, ClaudeHookRequest,
        HookPayloadSink, RecentHookEvents,
    };
    use super::{valid_fields, valid_request};
    use serde_json::{json, Value};
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::{Arc, Mutex},
        thread,
    };

    #[test]
    fn antigravity_admission_accepts_interrupt_and_rejects_permission_request() {
        for event in [
            "SessionStart",
            "PreInvocation",
            "Stop",
            "StopFailure",
            "Interrupt",
        ] {
            let body = json!({
                "source": "antigravity",
                "event": event,
                "tabId": "39c6b972-c888-42c0-a739-cbabc32969ac",
                "sessionId": "ec33ebf9-0cba-4100-8142-c61503f6c587",
                "timestamp": "2026-11-24T12:45:00Z"
            });
            let bytes = serde_json::to_vec(&body).unwrap();
            assert!(valid_fields(&bytes), "{event}");
            let req: ClaudeHookRequest = serde_json::from_slice(&bytes).unwrap();
            assert!(valid_request(&req), "{event}");
        }
        let denied = json!({
            "source": "antigravity",
            "event": "PermissionRequest",
            "tabId": "39c6b972-c888-42c0-a739-cbabc32969ac",
            "sessionId": "ec33ebf9-0cba-4100-8142-c61503f6c587",
            "timestamp": "2026-11-24T12:45:00Z"
        });
        let req: ClaudeHookRequest = serde_json::from_value(denied).unwrap();
        assert!(!valid_request(&req));
    }

    // 真 HTTP 走与 daemon 共用的鉴权、字段/值校验和事件转换；拦截在任何 sink 副作用之前。
    #[test]
    fn antigravity_rejects_out_of_scope_and_content_bearing_requests() {
        let baseline = json!({"source":"antigravity", "event":"PreInvocation", "tabId":"39c6b972-c888-42c0-a739-cbabc32969ac", "sessionId":"ec33ebf9-0cba-4100-8142-c61503f6c587", "timestamp":"2026-11-24T12:45:00Z"});
        let delivered = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&delivered);
        let sink: HookPayloadSink =
            Arc::new(move |payload: ClaudeHookPayload| capture.lock().unwrap().push(payload));
        let recent = Arc::new(Mutex::new(RecentHookEvents::default()));
        let submit = |body: &Value, auth: &str| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (stream, _) = listener.accept().unwrap();
            let sink = Arc::clone(&sink);
            let recent = Arc::clone(&recent);
            let worker = thread::spawn(move || handle_stream(stream, sink, "test", recent));
            let body = body.to_string();
            write!(client,"POST /api/claude-hook HTTP/1.1\r\nAuthorization: Bearer {auth}\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            worker.join().unwrap();
            response.split_whitespace().nth(1).unwrap().to_string()
        };
        assert_eq!(submit(&baseline, "test"), "204");
        let mut interrupt = baseline.clone();
        interrupt["event"] = json!("Interrupt");
        assert_eq!(submit(&interrupt, "test"), "204");
        assert_eq!(submit(&baseline, "wrong"), "401");
        for (key, val) in [
            ("tabId", "external:antigravity"),
            ("sessionId", "not-uuid"),
            ("event", "PermissionRequest"),
            ("timestamp", "invalid"),
            ("wslDistroName", "../Ubuntu"),
            ("lastUserInput", "private"),
            ("message", "raw error"),
            ("cwd", "/host"),
            ("transcriptPath", "/home/..."),
            ("environmentType", "ssh"),
        ] {
            let mut v = baseline.clone();
            v[key] = json!(val);
            assert_eq!(submit(&v, "test"), "400", "{key}");
        }
        let events = delivered.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event, "PreInvocation");
        assert_eq!(events[0].source, "antigravity");
        assert_eq!(events[1].event, "Interrupt");
        assert_eq!(events[1].source, "antigravity");
        let mut spool = baseline;
        spool["hostId"] = json!("remote");
        spool["projectId"] = json!("project");
        spool["eventId"] = json!("e");
        assert!(remote_hook_payload_from_spool(&spool).is_err());
    }
}
