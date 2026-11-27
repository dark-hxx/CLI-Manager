use super::*;
use serde_json::{json, Value};
const ID: &str = "ec33ebf9-0cba-4100-8142-c61503f6c587";
fn observe(event: &str, v: Value) -> Option<(&'static str, String)> {
    observation(event, serde_json::to_vec(&v).unwrap().as_slice())
}

#[test]
fn antigravity_missing_common_fields_does_not_require_prompt_transcript_or_event_name() {
    for event in ["SessionStart", "PreInvocation"] {
        assert_eq!(
            observe(
                event,
                json!({"conversationId":ID.to_uppercase(), "lastUserInput":{"unexpected":"never forwarded"}, "toolCall":{"args":"secret"} })
            ),
            Some((event, ID.into()))
        );
        // Empty-string protojson fields must be treated as absent, not contradictory.
        assert_eq!(
            observe(
                event,
                json!({"conversationId":ID, "transcriptPath":"", "hookEventName":""})
            ),
            Some((event, ID.into()))
        );
        assert_eq!(
            observe(
                event,
                json!({"conversationId":ID, "transcriptPath":"   ", "hookEventName":"  "})
            ),
            Some((event, ID.into()))
        );
    }
    assert_eq!(observe("PreToolUse", json!({"conversationId":ID})), None);
    for id in [
        "../../escape",
        "",
        "00000000-0000-0000-0000-000000000000",
        "ec33ebf90cba41008142c61503f6c587",
    ] {
        assert_eq!(observe("SessionStart", json!({"conversationId":id})), None);
    }
}

#[test]
fn antigravity_shared_config_rejects_app_ide_and_contradictory_hints() {
    for file in ["transcript.jsonl", "transcript_full.jsonl"] {
        let tail = format!("brain/{ID}/.system_generated/logs/{file}");
        for app in ["antigravity", "antigravity-ide", "antigravityCLI"] {
            assert!(observe(
                "PreInvocation",
                json!({"conversationId":ID,"transcriptPath":format!("/home/a/.gemini/{app}/{tail}")})
            )
            .is_none());
        }
        let posix = format!("/home/a/.gemini/antigravity-cli/{tail}");
        assert_eq!(
            observe(
                "PreInvocation",
                json!({"conversationId":ID, "transcriptPath":posix})
            ),
            Some(("PreInvocation", ID.into()))
        );
        let cli = format!("C:/Users/My Name/.gemini/antigravity-cli/{tail}").replace('/', "\\");
        assert_eq!(
            observe(
                "SessionStart",
                json!({"conversationId":ID.to_uppercase(), "transcriptPath":cli})
            ),
            Some(("SessionStart", ID.into()))
        );
        assert_eq!(
            observe(
                "Stop",
                json!({
                    "conversationId":ID,
                    "transcriptPath":cli,
                    "fullyIdle":true,
                    "terminationReason":"NO_TOOL_CALL"
                })
            ),
            Some(("Stop", ID.into()))
        );
        assert!(observe(
            "SessionStart",
            json!({"conversationId":ID, "transcriptPath":cli.replace(ID,"bad-id")})
        )
        .is_none());
        assert!(observe(
            "SessionStart",
            json!({
                "conversationId":ID,
                "transcriptPath":format!("C:\\Users\\a\\..\\.gemini\\antigravity-cli\\{tail}").replace('/', "\\")
            })
        )
        .is_none());
    }
    for bad_file in ["other.jsonl", "not_transcript.jsonl", "transcript_full.jsonl.bak"] {
        assert!(observe(
            "SessionStart",
            json!({
                "conversationId":ID,
                "transcriptPath":format!("C:\\Users\\a\\.gemini\\antigravity-cli\\brain\\{ID}\\.system_generated\\logs\\{bad_file}")
            })
        )
        .is_none());
    }
    assert!(observe(
        "SessionStart",
        json!({"conversationId":ID, "hookEventName":"PreInvocation"})
    )
    .is_none());
}

#[test]
fn antigravity_stop_requires_global_idle_and_positive_terminal_evidence() {
    for (reason, err, expect) in [
        ("NO_TOOL_CALL", "", Some("Stop")),
        ("TERMINAL_STEP_TYPE", "", Some("Stop")),
        ("INJECTED_RESPONSE", "", Some("Stop")),
        ("model_stop", "", Some("Stop")),
        ("USER_CANCELED", "", Some("Interrupt")),
        ("USER_CANCELED", "explicit error", Some("StopFailure")),
        ("ERROR", "", Some("StopFailure")),
        ("MAX_INVOCATIONS", "", Some("StopFailure")),
        ("MAX_FORCED_INVOCATIONS", "", Some("StopFailure")),
        ("MAX_TOKEN_BUDGET_EXCEEDED", "", Some("StopFailure")),
        ("TERMINAL_CUSTOM_HOOK", "", Some("StopFailure")),
        ("error", "", Some("StopFailure")),
        ("max_steps_exceeded", "", Some("StopFailure")),
        ("unknown", "", None),
        ("NO_TOOL_CALL", "sensitive failure", Some("StopFailure")),
        ("model_stop", "sensitive failure", Some("StopFailure")),
    ] {
        for idle in [None, Some(false), Some(true)] {
            let event = observe(
                "Stop",
                json!({"conversationId":ID,"fullyIdle":idle,"terminationReason":reason,"error":err}),
            );
            assert_eq!(
                event.map(|v| v.0),
                if idle == Some(true) { expect } else { None },
                "reason={reason} err={err:?} idle={idle:?}"
            );
        }
    }
    assert_eq!(
        observe("Stop", json!({"conversationId":ID,"fullyIdle":true})),
        None
    );
}

#[test]
fn antigravity_malformed_trailing_or_oversized_json_is_not_an_observation() {
    for bytes in [b"{".as_slice(), b"\xff", b"{} {}"] {
        assert!(observation("PreInvocation", bytes).is_none());
    }
    // Prompts above the old 64 KiB cap (e.g., pasted logs) must still be observed cleanly.
    let large_prompt = json!({"conversationId":ID,"lastUserInput":"x".repeat(128 * 1024)});
    assert_eq!(
        observe("PreInvocation", large_prompt),
        Some(("PreInvocation", ID.into()))
    );
    let mut text = json!({"conversationId":ID}).to_string();
    text.push_str(&" ".repeat(MAX_BYTES as usize));
    assert!(observation("SessionStart", text.as_bytes()).is_none());
    let oversized = json!({"conversationId":ID,"lastUserInput":"x".repeat(MAX_BYTES as usize)});
    assert!(observe("PreInvocation", oversized).is_none());
}

#[test]
fn antigravity_passive_json_has_no_injection_or_approval_override() {
    for (event, want) in [
        ("SessionStart", json!({})),
        ("PreInvocation", json!({})),
        ("Stop", json!({"decision":"stop"})),
        ("PreToolUse", json!({"decision":"ask"})),
        ("unknown", json!({})),
    ] {
        assert_eq!(
            serde_json::from_slice::<Value>(passive_response(event)).unwrap(),
            want
        );
    }
    for bad in ["", "-d", "../Ubuntu", "foo\\bar", " x", "z\n"] {
        assert!(!valid_distro(bad));
    }
    for bad in ["", "external:antigravity", " tab", "a\nb"] {
        assert!(!valid_tab_id(bad));
    }
    assert!(valid_distro("Ubuntu-24.04"));
    assert!(!valid_tab_id("tab-123"));
    assert!(valid_tab_id(ID));
}
