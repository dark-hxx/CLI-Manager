use super::{
    status::{model_name, permission_mode, profile_sandbox, rate_limits},
    *,
};
use crate::{
    event::{Limit, DIFF_TEXT, LABEL_TEXT, TASK_ITEMS},
    test_support::TempDir,
};
use serde_json::json;
use std::{fs, io::Write};

// 以下全為合成的測試資料。
const T: &str = "2026-10-15T07:15:26.280Z";
const AT: u64 = 1_792_048_526_280;
const ID: &str = "0199e3a1-5d55-7c1d-9a39-2f1f0e3b7a11";

fn line(kind: &str, payload: Value) -> Value {
    json!({"timestamp":T,"type":kind,"payload":payload})
}

fn event(payload: Value) -> Value {
    line("event_msg", payload)
}

fn response(payload: Value) -> Value {
    line("response_item", payload)
}

fn item(item: Value) -> Value {
    event(json!({"type":"item_completed","thread_id":"t1","turn_id":"turn-1","item":item}))
}

fn all_events(lines: &[Value]) -> Vec<Value> {
    let mut parser = Parser::new(Some("/work/app".into()));
    let mut out = Vec::new();
    for line in lines {
        parser.line(line.to_string().as_bytes(), &mut out);
    }
    out.iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect()
}

/// 多數測試不關心狀態事件，先濾掉。
fn events(lines: &[Value]) -> Value {
    Value::Array(
        all_events(lines)
            .into_iter()
            .filter(|event| event["kind"] != "status")
            .collect(),
    )
}

fn statuses(lines: &[Value]) -> Vec<Value> {
    all_events(lines)
        .into_iter()
        .filter(|event| event["kind"] == "status")
        .collect()
}

fn tool(id: &str, name: &str, summary: &str) -> Value {
    json!({"kind":"tool","at":AT,"id":id,"name":name,"summary":summary})
}

fn command(id: &str, summary: &str, detail: &str) -> Value {
    json!({"kind":"tool","at":AT,"id":id,"name":"Bash","summary":summary,"detail":detail})
}

fn result(id: &str, ok: bool, text: Option<&str>) -> Value {
    let mut event = json!({"kind":"result","at":AT,"id":id,"ok":ok});
    if let Some(text) = text {
        event["text"] = json!(text);
    }
    event
}

#[test]
fn legacy_events_give_prompts_replies_and_thinking_without_injected_context() {
    assert_eq!(
        events(&[
            line(
                "session_meta",
                json!({"id":ID,"cwd":"/work/app","cli_version":"0.40.0","source":"cli"})
            ),
            response(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<cwd>/work/app</cwd>\n</environment_context>"}]})
            ),
            response(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":"修复登录"}]})
            ),
            event(
                json!({"type":"user_message","message":"<user_instructions>\n规则\n</user_instructions>","kind":"user_instructions"})
            ),
            event(
                json!({"type":"user_message","message":"# AGENTS.md instructions for /work/app\n\n规则"})
            ),
            event(
                json!({"type":"user_message","message":"  修复登录\n","images":["data:image/png;base64,AAAA"],"local_images":[]})
            ),
            response(
                json!({"type":"reasoning","summary":[{"type":"summary_text","text":"**检查**"}],"encrypted_content":"x"})
            ),
            event(json!({"type":"agent_reasoning","text":"**检查** 先看测试"})),
            response(
                json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"已修复"}]})
            ),
            event(json!({"type":"agent_message","message":"已修复"})),
            // 同一段文字再由新版項目寫一次時不重複。
            item(
                json!({"type":"AgentMessage","id":"m1","content":[{"type":"Text","text":"已修复"}],"phase":"final_answer"})
            ),
            event(json!({"type":"turn_aborted","reason":"interrupted"})),
            event(json!({"type":"turn_aborted","reason":"replaced"})),
            event(json!({"type":"stream_error","message":"Reconnecting... 1/5"})),
            event(json!({"type":"warning","message":"\u{1b}[33m磁盘快满了\u{1b}[0m"})),
        ]),
        json!([
            {"kind":"user","uuid":"@0","at":AT,"text":"修复登录","images":1},
            {"kind":"thinking","at":AT,"text":"**检查** 先看测试"},
            {"kind":"assistant","at":AT,"text":"已修复"},
            {"kind":"notice","at":AT,"code":"turn_interrupted","text":"Turn interrupted"},
            {"kind":"notice","at":AT,"code":"turn_replaced","text":"Turn replaced by a new request"},
            {"kind":"error","at":AT,"text":"Reconnecting... 1/5"},
            {"kind":"notice","at":AT,"text":"磁盘快满了"},
        ])
    );
}

#[test]
fn a_message_sent_mid_turn_is_a_steer() {
    let last = json!({"input_tokens":5000,"cached_input_tokens":4000,"output_tokens":100});
    let usage = |total: u64| {
        event(
            json!({"type":"token_count","info":{"total_token_usage":{"input_tokens":total},"last_token_usage":last}}),
        )
    };
    let all = all_events(&[
        line(
            "turn_context",
            json!({"cwd":"/work/app","model":"gpt-5.1-codex-max"}),
        ),
        event(json!({"type":"task_started","turn_id":"turn-1"})),
        event(json!({"type":"user_message","message":"修复登录"})),
        usage(5000),
        event(json!({"type":"user_message","message":"先别改样式"})),
        // 新版項目再寫一次同一句：不重複。
        item(
            json!({"type":"UserMessage","id":"u2","content":[{"type":"text","text":"先别改样式"}]}),
        ),
        usage(10_000),
        event(json!({"type":"task_complete","turn_id":"turn-1","duration_ms":30_000})),
        event(json!({"type":"task_started","turn_id":"turn-2"})),
        event(json!({"type":"user_message","message":"再跑一次测试"})),
    ]);
    let shown = all
        .iter()
        .filter(|event| event["kind"] != "status")
        .map(|event| {
            format!(
                "{}:{}",
                event["kind"].as_str().unwrap(),
                event["text"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        shown,
        [
            "user:修复登录",
            "queued:先别改样式",
            "turn:",
            "user:再跑一次测试"
        ]
    );
    // 一輪結束只帶用時：花費由主機端依自己的價目表另外算。
    let turn = all.iter().find(|event| event["kind"] == "turn").unwrap();
    assert_eq!(turn, &json!({"kind":"turn","at":AT,"ms":30_000}));
}

#[test]
fn completed_items_become_timeline_events() {
    assert_eq!(
        events(&[
            line(
                "turn_context",
                json!({"cwd":"/work/app","model":"gpt-5.1-codex","effort":"high","approval_policy":"on-request"})
            ),
            event(
                json!({"type":"task_started","turn_id":"turn-1","started_at":1_792_048_520,"model_context_window":258_400})
            ),
            item(
                json!({"type":"UserMessage","id":"u0","content":[{"type":"text","text":"<environment_context>\n</environment_context>","text_elements":[]}]})
            ),
            item(
                json!({"type":"UserMessage","id":"u1","content":[{"type":"text","text":"看这张图","text_elements":[]},{"type":"local_image","path":"/tmp/a.png"}]})
            ),
            item(
                json!({"type":"Reasoning","id":"r1","summary_text":["**读代码**\n\n先看入口","**写测试**"],"raw_content":[]})
            ),
            item(json!({"type":"Reasoning","id":"r2","summary_text":[],"raw_content":[]})),
            item(
                json!({"type":"AgentMessage","id":"m1","content":[{"type":"Text","text":"我先运行测试。"}],"phase":"commentary"})
            ),
            item(
                json!({"type":"CommandExecution","id":"c1","command":["/bin/bash","-lc","cargo test\n--all"],"cwd":"/work/app","aggregated_output":"\u{1b}[31merror\u{1b}[0m: 1 failed\n","exit_code":101,"status":"failed","duration":{"secs":1,"nanos":0}})
            ),
            item(
                json!({"type":"McpToolCall","id":"p1","server":"stitch","tool":"get_screen","arguments":{"screenId":"s"},"result":{"content":[{"type":"text","text":"屏幕已生成"}],"isError":false},"status":"completed"})
            ),
            item(
                json!({"type":"McpToolCall","id":"p2","server":"stitch","tool":"list_projects","arguments":{},"error":{"message":"timeout"},"status":"failed"})
            ),
            item(
                json!({"type":"WebSearch","id":"ws1","query":"rust axum","action":{"type":"search","query":"rust axum"}})
            ),
            // 同一次搜尋也寫成 response_item 時略過。
            response(
                json!({"type":"web_search_call","id":"ws1","status":"completed","action":{"type":"search","query":"rust axum"}})
            ),
            response(
                json!({"type":"web_search_call","status":"completed","action":{"type":"open_page","url":"https://example.com"}})
            ),
            item(json!({"type":"ImageView","id":"v1","path":"/work/app/logo.png"})),
            item(json!({"type":"Plan","id":"plan1","text":"1. 写测试\n2. 修复"})),
            item(
                json!({"type":"SubAgentActivity","id":"s1","kind":"started","agent_path":"x","agent_thread_id":"y"})
            ),
            // 壓縮同時寫成 compacted 與 ContextCompaction，只顯示一次。
            line("compacted", json!({"message":"","replacement_history":[]})),
            line(
                "turn_context",
                json!({"cwd":"/work/app","model":"gpt-5.1-codex"})
            ),
            item(json!({"type":"ContextCompaction","id":"cc1"})),
            event(
                json!({"type":"task_complete","turn_id":"turn-1","duration_ms":64_000,"last_agent_message":"完成"})
            ),
            event(
                json!({"type":"task_complete","turn_id":"turn-2","error":{"message":"stream disconnected","codex_error_info":"other"},"started_at":1_792_048_520,"completed_at":1_792_048_530})
            ),
        ]),
        json!([
            {"kind":"user","uuid":"@0","at":AT,"text":"看这张图","images":1},
            {"kind":"thinking","uuid":"r1","at":AT,"text":"**读代码**\n\n先看入口"},
            {"kind":"thinking","uuid":"r1","at":AT,"text":"**写测试**"},
            {"kind":"thinking","uuid":"r2","at":AT},
            {"kind":"assistant","uuid":"m1","at":AT,"text":"我先运行测试。","model":"gpt-5.1-codex"},
            command("c1", "cargo test", "cargo test\n--all"),
            result("c1", false, Some("error: 1 failed")),
            tool("p1", "mcp__stitch__get_screen", "stitch · get_screen"),
            result("p1", true, Some("屏幕已生成")),
            tool("p2", "mcp__stitch__list_projects", "stitch · list_projects"),
            result("p2", false, Some("timeout")),
            tool("ws1", "WebSearch", "rust axum"),
            result("ws1", true, None),
            tool(&format!("search-{AT}-1"), "WebFetch", "https://example.com"),
            result(&format!("search-{AT}-1"), true, None),
            tool("v1", "Read", "logo.png"),
            {"kind":"result","uuid":"@0","at":AT,"id":"v1","ok":true,"image":true,"images":1},
            {"kind":"assistant","uuid":"plan1","at":AT,"text":"1. 写测试\n2. 修复","model":"gpt-5.1-codex"},
            {"kind":"compact","at":AT},
            {"kind":"turn","at":AT,"ms":64_000},
            {"kind":"error","at":AT,"text":"stream disconnected"},
            {"kind":"turn","at":AT,"ms":10_000},
        ])
    );
}

#[test]
fn response_tool_calls_pair_with_their_outputs() {
    assert_eq!(
        events(&[
            line("session_meta", json!({"id":ID,"cwd":"/work/app"})),
            response(
                json!({"type":"function_call","name":"shell","call_id":"s1","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls -la\"],\"workdir\":\"/work/app\"}"})
            ),
            response(
                json!({"type":"function_call_output","call_id":"s1","output":"{\"output\":\"a.rs\\nb.rs\\n\",\"metadata\":{\"exit_code\":0,\"duration_seconds\":0.1}}"})
            ),
            response(
                json!({"type":"function_call","name":"shell","call_id":"s2","arguments":"{\"command\":[\"git\",\"commit\",\"-m\",\"fix it\"]}"})
            ),
            response(
                json!({"type":"function_call_output","call_id":"s2","output":"Exit code: 1\nWall time: 0.2 seconds\nOutput:\nnothing to commit\n"})
            ),
            response(
                json!({"type":"function_call","name":"exec_command","call_id":"e1","arguments":"{\"cmd\":\"npm test\",\"workdir\":\"/work/app\",\"yield_time_ms\":1000}"})
            ),
            response(
                json!({"type":"function_call_output","call_id":"e1","output":"Chunk ID: 1a2b\nWall time: 1.0 seconds\nProcess running with session ID 7\nOriginal token count: 3\nOutput:\nrunning\n"})
            ),
            response(
                json!({"type":"function_call","name":"write_stdin","call_id":"w1","arguments":"{\"session_id\":7,\"chars\":\"\",\"yield_time_ms\":5000}"})
            ),
            response(
                json!({"type":"function_call_output","call_id":"w1","output":[{"type":"input_text","text":"Chunk ID: 3c4d\nWall time: 5.0 seconds\nProcess exited with code 2\nOriginal token count: 4\nOutput:\n2 failed\n"}]})
            ),
            response(
                json!({"type":"local_shell_call","call_id":"l1","status":"completed","action":{"type":"exec","command":["sh","-c","pwd"],"working_directory":"/work/app"}})
            ),
            response(json!({"type":"function_call_output","call_id":"l1","output":"/work/app"})),
            response(
                json!({"type":"function_call","name":"update_plan","call_id":"u1","arguments":"{\"explanation\":\"\",\"plan\":[{\"step\":\"读代码\",\"status\":\"completed\"},{\"step\":\"改代码\",\"status\":\"in_progress\"},{\"step\":\" \",\"status\":\"pending\"}]}"})
            ),
            response(json!({"type":"function_call_output","call_id":"u1","output":"Plan updated"})),
            // 程式碼模式的儲存格與等待不呈現。
            response(
                json!({"type":"custom_tool_call","name":"exec","call_id":"x1","status":"completed","input":"const r = await tools.exec_command({cmd: 'ls'});"})
            ),
            response(
                json!({"type":"custom_tool_call_output","call_id":"x1","output":[{"type":"input_text","text":"done"}]})
            ),
            response(
                json!({"type":"function_call","name":"wait","call_id":"x2","arguments":"{\"cell_id\":\"1\"}"})
            ),
            response(json!({"type":"function_call_output","call_id":"x2","output":"done"})),
            response(
                json!({"type":"function_call","name":"generate_screen","namespace":"mcp__stitch","call_id":"m1","arguments":"{\"prompt\":\"登录页\"}"})
            ),
            // 介面紀錄也寫了同一個 MCP 呼叫時略過。
            item(
                json!({"type":"McpToolCall","id":"m1","server":"stitch","tool":"generate_screen","status":"completed","result":{"content":[]}})
            ),
            response(
                json!({"type":"function_call_output","call_id":"m1","output":[{"type":"input_text","text":"已生成"},{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]})
            ),
            response(
                json!({"type":"function_call","name":"spawn_agent","namespace":"collaboration","call_id":"a1","arguments":"{\"agent_type\":\"explorer\",\"task_name\":\"找入口\",\"message\":\"找到 main 函数\"}"})
            ),
            response(
                json!({"type":"function_call_output","call_id":"a1","output":"{\"agent_id\":\"x\"}"})
            ),
            response(
                json!({"type":"function_call","name":"view_image","call_id":"v1","arguments":"{\"path\":\"/work/app/shot.png\"}"})
            ),
            response(json!({"type":"function_call_output","call_id":"v1","output":"attached"})),
            response(
                json!({"type":"function_call","name":"lookup","call_id":"g1","arguments":"{\"count\":2,\"query\":\"abc\"}"})
            ),
            response(json!({"type":"function_call_output","call_id":"g1","output":"ok"})),
            // 呼叫在讀取範圍之前：仍送出結果，有結束碼的視為命令。
            response(json!({"type":"function_call_output","call_id":"older","output":"see"})),
            response(
                json!({"type":"function_call_output","call_id":"older2","output":"Exit code: 1\nWall time: 1 seconds\nOutput:\nfailed\n"})
            ),
        ]),
        json!([
            command("s1", "ls -la", "ls -la"),
            result("s1", true, Some("a.rs\nb.rs")),
            command("s2", "git commit -m 'fix it'", "git commit -m 'fix it'"),
            result("s2", false, Some("nothing to commit")),
            command("e1", "npm test", "npm test"),
            result("e1", true, Some("running")),
            tool("w1", "BashOutput", ""),
            result("w1", false, Some("2 failed")),
            command("l1", "pwd", "pwd"),
            result("l1", true, Some("/work/app")),
            {"kind":"tasks","at":AT,"items":[
                {"id":"0","subject":"读代码","status":"completed"},
                {"id":"1","subject":"改代码","status":"in_progress"}
            ]},
            tool("m1", "mcp__stitch__generate_screen", "stitch · generate_screen"),
            {"kind":"result","uuid":"@0","at":AT,"id":"m1","ok":true,"text":"已生成","image":true,"images":1},
            {"kind":"tool","at":AT,"id":"a1","name":"Agent","summary":"找入口","detail":"找到 main 函数"},
            result("a1", true, None),
            tool("v1", "Read", "shot.png"),
            {"kind":"result","at":AT,"id":"v1","ok":true,"image":true},
            tool("g1", "lookup", "abc"),
            result("g1", true, Some("ok")),
            result("older", true, Some("see")),
            result("older2", false, Some("failed")),
        ])
    );
}

#[test]
fn patches_show_one_edit_per_file_with_diffs() {
    let patch = "*** Begin Patch\n*** Update File: src/lib.rs\n@@ fn main\n fn main() {\n-    old();\n+    new();\n }\n*** Add File: docs/new.md\n+# 标题\n+内容\n*** Delete File: old.txt\n*** Update File: a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** End Patch\n";
    let diff = |hunk: Value, added: u64, removed: u64| json!({"kind":"result","at":AT,"ok":true,"diff":[hunk],"added":added,"removed":removed});
    let with_id = |mut event: Value, id: &str| {
        event["id"] = json!(id);
        event
    };
    let produced = events(&[
        line("turn_context", json!({"cwd":"/work/app"})),
        response(
            json!({"type":"custom_tool_call","name":"apply_patch","call_id":"p1","status":"completed","input":patch}),
        ),
        // 介面紀錄有含行號的差異，取代從修補文字推算的版本。
        item(
            json!({"type":"FileChange","id":"p1","status":"completed","changes":{"/work/app/src/lib.rs":{"type":"update","unified_diff":"@@ -3,3 +3,3 @@ fn main\n fn main() {\n-    old();\n+    new();\n }\n","move_path":null}}}),
        ),
        response(
            json!({"type":"custom_tool_call_output","call_id":"p1","output":"Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM src/lib.rs\nA docs/new.md\nD old.txt\nM b.txt\n"}),
        ),
        response(
            json!({"type":"custom_tool_call","name":"apply_patch","call_id":"p2","input":"*** Begin Patch\n*** Update File: missing.rs\n@@\n-a\n+b\n*** End Patch"}),
        ),
        response(
            json!({"type":"custom_tool_call_output","call_id":"p2","output":"apply_patch verification failed: Failed to find expected lines in missing.rs"}),
        ),
        // 程式碼模式的修改只有介面紀錄。
        item(
            json!({"type":"FileChange","id":"f1","status":"completed","changes":{
                "/work/app/gone.rs":{"type":"delete","content":"x\ny\n"},
                "/work/app/new.rs":{"type":"add","content":"fn a() {}\n"}
            }}),
        ),
        // 舊版的修補事件（以 call_id 對應）。
        event(
            json!({"type":"patch_apply_begin","call_id":"q1","auto_approved":true,"changes":{"/work/app/c.rs":{"update":{"unified_diff":"@@ -1 +1 @@\n-a\n+b\n","move_path":null}}}}),
        ),
        event(
            json!({"type":"patch_apply_end","call_id":"q1","stdout":"","stderr":"","success":true}),
        ),
    ]);
    assert_eq!(
        produced,
        json!([
            tool("p1#0", "Edit", "src/lib.rs"),
            tool("p1#1", "Write", "docs/new.md"),
            tool("p1#2", "Edit", "old.txt"),
            tool("p1#3", "Edit", "a.txt → b.txt"),
            with_id(diff(json!({"oldStart":3,"oldLines":3,"newStart":3,"newLines":3,"lines":[" fn main() {","-    old();","+    new();"," }"]}), 1, 1), "p1#0"),
            with_id(diff(json!({"oldStart":0,"oldLines":0,"newStart":1,"newLines":2,"lines":["+# 标题","+内容"]}), 2, 0), "p1#1"),
            {"kind":"result","at":AT,"id":"p1#2","ok":true,"added":0,"removed":0},
            with_id(diff(json!({"oldStart":0,"oldLines":1,"newStart":0,"newLines":1,"lines":["-x","+y"]}), 1, 1), "p1#3"),
            tool("p2", "Edit", "missing.rs"),
            result("p2", false, Some("apply_patch verification failed: Failed to find expected lines in missing.rs")),
            tool("f1#0", "Edit", "gone.rs"),
            tool("f1#1", "Write", "new.rs"),
            with_id(diff(json!({"oldStart":1,"oldLines":2,"newStart":0,"newLines":0,"lines":["-x","-y"]}), 0, 2), "f1#0"),
            with_id(diff(json!({"oldStart":0,"oldLines":0,"newStart":1,"newLines":1,"lines":["+fn a() {}"]}), 1, 0), "f1#1"),
            tool("q1", "Edit", "c.rs"),
            with_id(diff(json!({"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-a","+b"]}), 1, 1), "q1"),
        ])
    );

    // 超過 300 行只保留開頭，增減行數仍以全文計算。
    let big = (0..450)
        .map(|index| format!("+line{index}\n"))
        .collect::<String>();
    let produced = events(&[
        response(
            json!({"type":"custom_tool_call","name":"apply_patch","call_id":"p3","input":format!("*** Begin Patch\n*** Add File: big.txt\n{big}*** End Patch")}),
        ),
        response(
            json!({"type":"custom_tool_call_output","call_id":"p3","output":"{\"output\":\"Success. Updated the following files:\\nA big.txt\\n\",\"metadata\":{\"exit_code\":0}}"}),
        ),
    ]);
    let result = &produced[1];
    assert_eq!(result["diff"][0]["lines"].as_array().unwrap().len(), 300);
    assert_eq!(result["diff"][0]["newLines"], 450);
    assert_eq!(
        (&result["added"], &result["truncated"]),
        (&json!(450), &json!(true))
    );
}

#[test]
fn diffs_plans_and_ids_are_bounded() {
    // 一個修補改兩個大檔案：每個檔案的差異各自受總字元數限制；超長的呼叫 ID 截斷後，兩個檔案的
    // 工具事件仍各自不同，也和各自的結果對得上。
    let body = (0..300)
        .map(|_| format!("+{}\n", "x".repeat(1_000)))
        .collect::<String>();
    let patch = format!(
        "*** Begin Patch\n*** Add File: a.txt\n{body}*** Add File: b.txt\n{body}*** End Patch"
    );
    let id = format!("call_{}", "9".repeat(1_000));
    let steps = (0..150)
        .map(|index| json!({"step":format!("步驟{index}"),"status":"pending"}))
        .collect::<Vec<_>>();
    let produced = events(&[
        response(
            json!({"type":"custom_tool_call","name":"apply_patch","call_id":id,"input":patch}),
        ),
        response(
            json!({"type":"custom_tool_call_output","call_id":id,"output":"Exit code: 0\nOutput:\nSuccess.\n"}),
        ),
        response(
            json!({"type":"function_call","name":"update_plan","call_id":"u1","arguments":json!({"plan":steps}).to_string()}),
        ),
    ]);
    let produced = produced.as_array().unwrap();
    assert_eq!(produced.len(), 5);
    let (tools, results) = (&produced[..2], &produced[2..4]);
    assert_ne!(tools[0]["id"], tools[1]["id"]);
    for (tool, result) in tools.iter().zip(results) {
        assert_eq!(tool["id"], result["id"]);
        assert_eq!(tool["id"].as_str().unwrap().chars().count(), LABEL_TEXT);
        let total = result["diff"][0]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap().chars().count())
            .sum::<usize>();
        assert!(total <= DIFF_TEXT + 1, "{total}");
        assert_eq!(
            (&result["added"], &result["truncated"]),
            (&json!(300), &json!(true))
        );
    }
    let items = produced[4]["items"].as_array().unwrap();
    assert_eq!(items.len(), TASK_ITEMS);
    assert_eq!(items[TASK_ITEMS - 1]["subject"], "步驟99");
}

#[test]
fn shell_patches_and_legacy_exec_events() {
    let patch = "*** Begin Patch\n*** Update File: a.rs\n@@\n-x\n+y\n*** End Patch";
    let edited = |id: &str, start: u64| json!({"kind":"result","at":AT,"id":id,"ok":true,"diff":[{"oldStart":start,"oldLines":1,"newStart":start,"newLines":1,"lines":["-x","+y"]}],"added":1,"removed":1});
    assert_eq!(
        events(&[
            line("session_meta", json!({"id":ID,"cwd":"/work/app"})),
            // 舊版經由殼層工具呼叫 apply_patch。
            response(
                json!({"type":"function_call","name":"shell","call_id":"s1","arguments":json!({"command":["apply_patch",patch]}).to_string()})
            ),
            response(
                json!({"type":"function_call_output","call_id":"s1","output":"{\"output\":\"Success. Updated the following files:\\nM a.rs\\n\",\"metadata\":{\"exit_code\":0}}"})
            ),
            // exec_command 的 heredoc；介面紀錄補上行號。
            response(
                json!({"type":"function_call","name":"exec_command","call_id":"e1","arguments":json!({"cmd":format!("apply_patch <<'EOF'\n{patch}\nEOF")}).to_string()})
            ),
            item(
                json!({"type":"FileChange","id":"e1","status":"completed","changes":{"/work/app/a.rs":{"type":"update","unified_diff":"@@ -7 +7 @@\n-x\n+y\n","move_path":null}}})
            ),
            response(
                json!({"type":"function_call_output","call_id":"e1","output":"Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nSuccess.\n"})
            ),
            // 舊版的命令事件與 function_call 是同一個呼叫：只呈現一次，結果取先到的一筆。
            response(
                json!({"type":"function_call","name":"shell","call_id":"s2","arguments":"{\"command\":[\"bash\",\"-lc\",\"make\"]}"})
            ),
            event(
                json!({"type":"exec_command_begin","call_id":"s2","command":["bash","-lc","make"],"cwd":"/work/app"})
            ),
            event(
                json!({"type":"exec_command_end","call_id":"s2","stdout":"","stderr":"boom\n","exit_code":2})
            ),
            response(
                json!({"type":"function_call_output","call_id":"s2","output":"{\"output\":\"boom\",\"metadata\":{\"exit_code\":2}}"})
            ),
            event(
                json!({"type":"exec_command_begin","call_id":"s3","command":["ls"],"cwd":"/work/app"})
            ),
            event(
                json!({"type":"exec_command_end","call_id":"s3","aggregated_output":"a\n","exit_code":0})
            ),
        ]),
        json!([
            tool("s1", "Edit", "a.rs"),
            edited("s1", 0),
            tool("e1", "Edit", "a.rs"),
            edited("e1", 7),
            command("s2", "make", "make"),
            result("s2", false, Some("boom")),
            command("s3", "ls", "ls"),
            result("s3", true, Some("a")),
        ])
    );
}

#[test]
fn status_follows_settings_usage_and_plan_limits() {
    let usage = |rate_limits: Value| {
        event(
            json!({"type":"token_count","info":{"total_token_usage":{"input_tokens":9000},"last_token_usage":{"input_tokens":5000,"cached_input_tokens":4000,"output_tokens":100},"model_context_window":272_000},"rate_limits":rate_limits}),
        )
    };
    let limits = json!([
        {"kind":"five_hour","usedPercent":12.5,"resetsAt":1_792_050_000u64,"windowMinutes":300},
        {"kind":"seven_day","usedPercent":40.0,"resetsAt":1_792_600_000u64,"windowMinutes":10_080}
    ]);
    assert_eq!(
        statuses(&[
            line(
                "turn_context",
                json!({"cwd":"/work/app","model":"gpt-5.1-codex-max","effort":"xhigh","approval_policy":"never","sandbox_policy":{"type":"danger-full-access"}})
            ),
            usage(
                json!({"limit_id":"codex","secondary":{"used_percent":40.0,"window_minutes":10_080,"resets_at":1_792_600_000u64},"primary":{"used_percent":12.5,"window_minutes":300,"resets_at":1_792_050_000u64}})
            ),
            // 內容相同不再送出；沒有額度或其他額度的紀錄保留已知數值。
            usage(json!({"limit_id":"codex","primary":null,"secondary":null})),
            usage(
                json!({"limit_id":"premium","primary":{"used_percent":99.0,"window_minutes":300}})
            ),
            event(
                json!({"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.1-codex-max","reasoning_effort":"low","approval_policy":"on-request","approvals_reviewer":"user","permission_profile":{"type":"managed","file_system":{"type":"restricted","entries":[{"access":"read"},{"access":"write"}]}}}})
            ),
        ]),
        vec![
            json!({"kind":"status","model":"gpt-5.1-codex-max","modelName":"GPT-5.1-Codex-Max","effort":"xhigh","permissionMode":"full-access"}),
            json!({"kind":"status","model":"gpt-5.1-codex-max","modelName":"GPT-5.1-Codex-Max","effort":"xhigh","permissionMode":"full-access","contextTokens":5000,"contextUsage":{"input":1000,"cacheRead":4000,"cacheWrite":0,"output":100},"contextWindow":272_000,"limits":limits}),
            json!({"kind":"status","model":"gpt-5.1-codex-max","modelName":"GPT-5.1-Codex-Max","effort":"low","permissionMode":"on-request","contextTokens":5000,"contextUsage":{"input":1000,"cacheRead":4000,"cacheWrite":0,"output":100},"contextWindow":272_000,"limits":limits}),
        ]
    );
    assert_eq!(model_name("gpt-5"), "GPT-5");
    let read_only = json!({"type":"managed","file_system":{"entries":[{"access":"read"}]}});
    assert_eq!(profile_sandbox(&read_only).as_deref(), Some("read-only"));
    assert_eq!(
        permission_mode(
            Some("on-request"),
            Some("workspace-write"),
            Some("auto_review")
        )
        .as_deref(),
        Some("auto-review")
    );
    assert_eq!(
        permission_mode(Some("on-request"), Some("read-only"), Some("user")).as_deref(),
        Some("read-only")
    );
    assert_eq!(
        permission_mode(Some("on-request"), Some("workspace-write"), None).as_deref(),
        Some("on-request")
    );
    assert_eq!(model_name("o3"), "o3");
    // 較早的格式：剩餘秒數依該行時間換算、攤平的欄位、無法辨識長度時以欄位名稱表示。
    let value = |limits: Vec<Limit>| serde_json::to_value(limits).unwrap();
    assert_eq!(
        value(rate_limits(
            &json!({"primary":{"used_percent":5.0,"window_minutes":299,"resets_in_seconds":600},"secondary":{"used_percent":150.0,"window_minutes":43_200}}),
            Some(AT),
        )),
        json!([
            {"kind":"five_hour","usedPercent":5.0,"resetsAt":1_792_049_126u64,"windowMinutes":299},
            {"kind":"secondary","usedPercent":100.0,"windowMinutes":43_200}
        ])
    );
    assert_eq!(
        value(rate_limits(
            &json!({"primary_used_percent":20.0,"secondary_used_percent":3.5,"primary_window_minutes":300,"secondary_window_minutes":10_080}),
            None,
        )),
        json!([
            {"kind":"five_hour","usedPercent":20.0,"windowMinutes":300},
            {"kind":"seven_day","usedPercent":3.5,"windowMinutes":10_080}
        ])
    );
    assert!(rate_limits(&json!(null), Some(AT)).is_empty());
}

#[test]
fn invalid_lines_are_skipped() {
    let mut parser = Parser::new(None);
    let mut out = Vec::new();
    parser.line(b"{not json", &mut out);
    parser.line(b"[1,2,3]", &mut out);
    parser.line(b"{\"type\":\"event_msg\"}", &mut out);
    parser.line(b"{\"type\":\"mystery\",\"payload\":{}}", &mut out);
    parser.line(b"{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"y\"}}", &mut out);
    assert!(out.is_empty());
}

#[test]
fn windows_follow_complete_lines_like_claude_transcripts() {
    let directory = TempDir::new("codex-windows");
    let path = directory.path().join("rollout.jsonl");
    let prompt = |index: usize| {
        format!(
            "{}\n",
            item(
                json!({"type":"UserMessage","id":format!("u{index}"),"content":[{"type":"text","text":format!("prompt {index}")}]})
            )
        )
    };
    let first = [prompt(0), prompt(1)].concat();
    let next = prompt(2);
    fs::write(&path, format!("{first}{}", &next[..10])).unwrap();
    let limits = Limits {
        window: 1 << 20,
        catch_up: 1 << 20,
        line: 1 << 20,
        ..Limits::default()
    };
    let texts = |page: &Page| {
        page.events
            .iter()
            .filter_map(|event| match event {
                Event::User { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let page = read(&path, Window::Tail, &limits, Some("/work/app")).unwrap();
    assert_eq!(
        (page.start, page.cursor, page.more),
        (0, first.len() as u64, false)
    );
    assert_eq!(texts(&page), ["prompt 0", "prompt 1"]);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&next.as_bytes()[10..]).unwrap();
    let page = read(&path, Window::After(first.len() as u64), &limits, None).unwrap();
    assert_eq!(texts(&page), ["prompt 2"]);
    let page = read(
        &path,
        Window::Before(first.len() as u64),
        &Limits {
            window: prompt(1).len() as u64,
            ..limits
        },
        None,
    )
    .unwrap();
    assert_eq!((page.start, page.more), (prompt(0).len() as u64, true));
    assert_eq!(texts(&page), ["prompt 1"]);
}

#[test]
fn incremental_reads_pair_calls_across_pages() {
    let directory = TempDir::new("codex-pages");
    let path = directory.path().join("rollout.jsonl");
    let text = |values: &[Value]| {
        values
            .iter()
            .map(|value| format!("{value}\n"))
            .collect::<String>()
    };
    let head = text(&[
        line(
            "turn_context",
            json!({"cwd":"/work/app","model":"gpt-5-codex","effort":"high","approval_policy":"on-request"}),
        ),
        response(
            json!({"type":"custom_tool_call","name":"apply_patch","call_id":"p1","input":"*** Begin Patch\n*** Update File: a.rs\n@@\n-x\n+y\n*** Update File: b.rs\n@@\n-1\n+2\n*** End Patch"}),
        ),
    ]);
    let tail = text(&[
        item(
            json!({"type":"FileChange","id":"p1","status":"completed","changes":{
                "/work/app/a.rs":{"type":"update","unified_diff":"@@ -4 +4 @@\n-x\n+y\n","move_path":null},
                "/work/app/b.rs":{"type":"update","unified_diff":"@@ -9 +9 @@\n-1\n+2\n","move_path":null}
            }}),
        ),
        response(
            json!({"type":"custom_tool_call_output","call_id":"p1","output":"Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.\n"}),
        ),
    ]);
    fs::write(&path, &head).unwrap();
    let limits = Limits {
        window: 1 << 20,
        catch_up: 1 << 20,
        line: 1 << 20,
        ..Limits::default()
    };
    let kinds = |page: &Page| {
        page.events
            .iter()
            .map(|event| {
                let value = serde_json::to_value(event).unwrap();
                format!(
                    "{}:{}",
                    value["kind"].as_str().unwrap(),
                    value["id"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
    };
    let first = read(&path, Window::Tail, &limits, None).unwrap();
    assert_eq!(kinds(&first), ["status:", "tool:p1#0", "tool:p1#1"]);
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(tail.as_bytes()).unwrap();
    // 下一次讀取只有介面紀錄與輸出：預讀之前的呼叫，結果附上精確差異，工具不重複、狀態不重送。
    let next = read(&path, Window::After(first.cursor), &limits, None).unwrap();
    assert_eq!(kinds(&next), ["result:p1#0", "result:p1#1"]);
    let diff = serde_json::to_value(&next.events[1]).unwrap();
    assert_eq!(diff["diff"][0]["oldStart"], 9);
    // 初始視窗從中間開始時，先送出預讀得到的設定。
    let small = Limits {
        window: tail.len() as u64,
        ..limits
    };
    let page = read(&path, Window::Tail, &small, None).unwrap();
    assert_eq!(page.start, head.len() as u64);
    assert_eq!(kinds(&page), ["status:", "result:p1#0", "result:p1#1"]);
}
