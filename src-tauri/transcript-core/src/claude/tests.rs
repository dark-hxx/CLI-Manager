use super::*;
use crate::{
    event::{DIFF_HUNKS, DIFF_TEXT, LABEL_TEXT, TASK_ITEMS, TASK_TEXT},
    test_support::TempDir,
};
use serde_json::json;
use std::fs;

const T: &str = "2026-10-15T07:15:26.280Z";
const AT: u64 = 1_792_048_526_280;

fn all_events(lines: &[Value]) -> Value {
    let mut parser = Parser::new(Some("/work/app".into()));
    let mut out = Vec::new();
    for line in lines {
        parser.line(line.to_string().as_bytes(), &mut out);
    }
    serde_json::to_value(out).unwrap()
}

/// 其他測試不關心狀態事件，先濾掉。
fn events(lines: &[Value]) -> Value {
    let all = all_events(lines);
    Value::Array(
        all.as_array()
            .unwrap()
            .iter()
            .filter(|event| event["kind"] != "status")
            .cloned()
            .collect(),
    )
}

#[test]
fn status_follows_model_effort_mode_speed_and_context() {
    let mut prompt = user(json!("hi"));
    prompt["permissionMode"] = json!("acceptEdits");
    prompt["effort"] = json!("max");
    let model = json!({"type":"attachment","uuid":"m1","timestamp":T,"attachment":{"type":"model","identity":{"modelId":"claude-opus-5[1m]","marketingName":"Opus 5 (1M context)"}}});
    let mut reply = assistant(json!([{"type":"text","text":"ok"}]));
    reply["message"]["model"] = json!("claude-opus-5");
    reply["message"]["usage"] = json!({"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":50,"speed":"fast"});
    let events = all_events(&[prompt, model, reply.clone(), reply]);
    // 快速模式的回覆自己也標出來（摺疊列、工作中那一列要寫 Fast）。
    assert!(events
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == "assistant")
        .all(|event| event["fast"] == true));
    let statuses: Vec<Value> = events
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == "status")
        .cloned()
        .collect();
    assert_eq!(
        statuses.last().unwrap(),
        &json!({"kind":"status","model":"claude-opus-5","modelName":"Opus 5 (1M context)","effort":"max","permissionMode":"acceptEdits","speed":"fast","contextTokens":3210,"contextUsage":{"input":10,"cacheRead":3000,"cacheWrite":200,"output":50},"contextWindow":1000000})
    );
    // 沒有變化的重複行不再送出。
    assert_eq!(statuses.len(), 3);
}

fn user(content: Value) -> Value {
    json!({"type":"user","uuid":"u1","timestamp":T,"cwd":"/work/app","message":{"role":"user","content":content}})
}

fn assistant(content: Value) -> Value {
    json!({"type":"assistant","uuid":"a1","timestamp":T,"cwd":"/work/app","message":{"model":"claude-test","content":content}})
}

fn tool(id: &str, name: &str, input: Value) -> Value {
    assistant(json!([{"type":"tool_use","id":id,"name":name,"input":input}]))
}

fn result(id: &str, content: Value, error: Option<bool>, data: Value) -> Value {
    let mut block = json!({"type":"tool_result","tool_use_id":id,"content":content});
    if let Some(error) = error {
        block["is_error"] = json!(error);
    }
    json!({"type":"user","uuid":"r1","timestamp":T,"cwd":"/work/app","message":{"content":[block]},"toolUseResult":data})
}

fn system(subtype: &str, fields: Value) -> Value {
    let mut line =
        json!({"type":"system","subtype":subtype,"uuid":"s1","timestamp":T,"isMeta":true});
    for (key, value) in fields.as_object().unwrap() {
        line[key] = value.clone();
    }
    line
}

#[test]
fn local_command_slash_tags_and_synthetic_replies() {
    let synthetic = |text: &str| json!({"type":"assistant","uuid":"a9","timestamp":T,"message":{"model":"<synthetic>","content":[{"type":"text","text":text}]}});
    assert_eq!(
        events(&[
            system(
                "local_command",
                json!({"content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>"})
            ),
            system(
                "local_command",
                json!({"content":"<local-command-stdout>Kept model as `Opus 5 (1M context)`</local-command-stdout>"})
            ),
            synthetic("No response requested."),
            synthetic("API Error: 529 overloaded"),
            user(
                json!([{"type":"text","text":"\n<command-message>effort</command-message>\n<command-name>/effort</command-name>\n<command-args>max</command-args>"}])
            ),
        ]),
        json!([
            {"kind":"command","uuid":"s1","at":AT,"name":"/model"},
            {"kind":"commandOutput","uuid":"s1","at":AT,"text":"Kept model as `Opus 5 (1M context)`"},
            {"kind":"error","at":AT,"text":"API Error: 529 overloaded"},
            {"kind":"command","uuid":"u1","at":AT,"name":"/effort","args":"max"},
        ])
    );
}

#[test]
fn user_prompts_drop_reminders_internal_lines_and_markers() {
    let mut meta = user(json!("内部展开"));
    meta["isMeta"] = json!(true);
    let mut side = user(json!("子代理"));
    side["isSidechain"] = json!(true);
    let mut compact = user(json!("This session is being continued"));
    compact["isCompactSummary"] = json!(true);
    assert_eq!(
        events(&[
            user(json!(
                "<system-reminder>ignore</system-reminder>\n修复登录问题"
            )),
            user(json!([
                {"type":"text","text":"<system-reminder>only</system-reminder>"},
                {"type":"text","text":"看这张图"},
                {"type":"image","source":{"type":"base64","data":"AAAA"}},
                {"type":"image","source":{"type":"base64","data":"BBBB"}}
            ])),
            user(json!("<system-reminder>nothing else</system-reminder>")),
            user(json!([{"type":"text","text":"[Request interrupted by user]"}])),
            meta,
            side,
            compact,
        ]),
        json!([
            {"kind":"user","uuid":"u1","at":AT,"text":"修复登录问题"},
            {"kind":"user","uuid":"u1","at":AT,"text":"看这张图","images":2},
            {"kind":"notice","at":AT,"code":"turn_interrupted","text":"[Request interrupted by user]"},
        ])
    );
}

#[test]
fn slash_commands_bash_mode_and_local_output() {
    let mut caveat = user(json!(
        "<local-command-caveat>Caveat: generated locally</local-command-caveat>"
    ));
    caveat["isMeta"] = json!(false);
    let long = format!(
        "<local-command-stdout>{}</local-command-stdout>",
        "x".repeat(5000)
    );
    assert_eq!(
        events(&[
            user(json!("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>")),
            user(json!("<command-message>clear</command-message>\n<command-name>/clear</command-name>\n<command-args></command-args>")),
            caveat,
            user(json!("<local-command-stdout>\u{1b}[1mSet model to opus\u{1b}[22m</local-command-stdout>")),
            user(json!("<local-command-stdout></local-command-stdout>")),
            user(json!("<bash-input>ls -la</bash-input>")),
            user(json!("<bash-stdout>file.txt\n</bash-stdout><bash-stderr>warn</bash-stderr>")),
            system("local_command", json!({"content": long})),
        ]),
        json!([
            {"kind":"command","uuid":"u1","at":AT,"name":"/model","args":"opus"},
            {"kind":"command","uuid":"u1","at":AT,"name":"/clear"},
            {"kind":"commandOutput","uuid":"u1","at":AT,"text":"Set model to opus","ansi":"\u{1b}[1mSet model to opus"},
            {"kind":"command","uuid":"u1","at":AT,"name":"!","args":"ls -la"},
            {"kind":"commandOutput","uuid":"u1","at":AT,"text":"file.txt\nwarn"},
            {"kind":"commandOutput","uuid":"s1","at":AT,"text":format!("{}…", "x".repeat(4000))},
        ])
    );
}

#[test]
fn context_output_keeps_colors_next_to_plain_text() {
    // Claude Code 2.1.300 的 /context：命令與輸出各是一行 system local_command，輸出是 Ink
    // 畫好的 256 色格子；第一行縮排一格，格子行沒有縮排。
    let output = " \u{1b}[1mContext Usage\u{1b}[22m\n\u{1b}[38;5;244m⛀ \u{1b}[38;5;140m⛁ ⛁ \u{1b}[39m  \u{1b}[38;5;246m\u{1b}[3mEstimated usage by category\u{1b}[23m\u{1b}[39m\n\u{1b}[38;5;246m⛶ ⛝ \u{1b}[39m  \u{1b}[38;5;140m⛁\u{1b}[39m Messages: \u{1b}[38;5;246m45.4k tokens (22.7%)\u{1b}[39m\n";
    assert_eq!(
        events(&[
            system(
                "local_command",
                json!({"content":"<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>"})
            ),
            system(
                "local_command",
                json!({"content": format!("<local-command-stdout>{output}</local-command-stdout>")})
            ),
        ]),
        json!([
            {"kind":"command","uuid":"s1","at":AT,"name":"/context"},
            {
                "kind":"commandOutput","uuid":"s1","at":AT,
                "text":"Context Usage\n⛀ ⛁ ⛁   Estimated usage by category\n⛶ ⛝   ⛁ Messages: 45.4k tokens (22.7%)",
                "ansi":" \u{1b}[1mContext Usage\u{1b}[22m\n\u{1b}[38;5;244m⛀ \u{1b}[38;5;140m⛁ ⛁ \u{1b}[39m  \u{1b}[38;5;246m\u{1b}[3mEstimated usage by category\u{1b}[23m\u{1b}[39m\n\u{1b}[38;5;246m⛶ ⛝ \u{1b}[39m  \u{1b}[38;5;140m⛁\u{1b}[39m Messages: \u{1b}[38;5;246m45.4k tokens (22.7%)"
            },
        ])
    );
    // `!` 命令的輸出（bash-stdout）一樣保留顏色；沒有顏色的照舊只有純文字。
    assert_eq!(
        events(&[
            user(json!(
                "<bash-stdout>\u{1b}[32m✓\u{1b}[0m 18 passed</bash-stdout>"
            )),
            user(json!("<bash-stdout>plain\u{1b}[0m</bash-stdout>")),
        ]),
        json!([
            {"kind":"commandOutput","uuid":"u1","at":AT,"text":"✓ 18 passed","ansi":"\u{1b}[32m✓\u{1b}[0m 18 passed"},
            {"kind":"commandOutput","uuid":"u1","at":AT,"text":"plain"},
        ])
    );
}

#[test]
fn assistant_text_thinking_and_tool_summaries() {
    let mut synthetic = assistant(json!([{"type":"text","text":"No response requested."}]));
    synthetic["message"]["model"] = json!("<synthetic>");
    let tool = |id: &str, name: &str, summary: &str| json!({"kind":"tool","uuid":"a1","at":AT,"id":id,"name":name,"summary":summary});
    let with_detail = |id: &str, name: &str, summary: &str, detail: &str| {
        let mut event = tool(id, name, summary);
        event["detail"] = json!(detail);
        event
    };
    assert_eq!(
        events(&[
            assistant(json!([
                {"type":"thinking","thinking":"先看看测试","signature":"s"},
                {"type":"thinking","thinking":"","signature":"s"},
                {"type":"text","text":"\n完成了\n"},
                {"type":"text","text":"  "},
                {"type":"fallback","from":"a","to":"b"},
                {"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/work/app/src/main.rs","offset":1}},
                {"type":"tool_use","id":"t2","name":"Bash","input":{"command":"\ncargo test \\\n  --all","description":"Run tests"}},
                {"type":"tool_use","id":"t3","name":"Grep","input":{"pattern":"fn main","path":"/work/app/src"}},
                {"type":"tool_use","id":"t4","name":"Glob","input":{"pattern":"**/*.rs"}},
                {"type":"tool_use","id":"t5","name":"WebFetch","input":{"url":"https://example.com","prompt":"read"}},
                {"type":"tool_use","id":"t6","name":"WebSearch","input":{"query":"rust axum"}},
                {"type":"tool_use","id":"t7","name":"Agent","input":{"description":"Explore code","prompt":"Find the parser","subagent_type":"Explore"}},
                {"type":"tool_use","id":"t8","name":"Skill","input":{"skill":"review","args":"--fast"}},
                {"type":"tool_use","id":"t9","name":"ExitPlanMode","input":{"plan":"1. 写测试","planFilePath":"/tmp/plan.md"}},
                {"type":"tool_use","id":"t10","name":"mcp__codeg-mcp__ask_user_question","input":{"questions":[]}},
                {"type":"tool_use","id":"t11","name":"Monitor","input":{"body":"two\nlines","command":"tail -f log","persistent":true}},
                {"type":"tool_use","id":"t12","name":"Edit","input":{"file_path":"/etc/hosts","old_string":"a","new_string":"b"}},
                {"type":"tool_use","id":"t13","name":"ToolSearch","input":{"max_results":5}}
            ])),
            synthetic,
        ]),
        json!([
            {"kind":"thinking","uuid":"a1","at":AT,"text":"先看看测试"},
            {"kind":"thinking","uuid":"a1","at":AT},
            {"kind":"assistant","uuid":"a1","at":AT,"text":"完成了","model":"claude-test"},
            tool("t1", "Read", "src/main.rs"),
            with_detail("t2", "Bash", "cargo test \\", "cargo test \\\n  --all"),
            tool("t3", "Grep", "fn main · src"),
            tool("t4", "Glob", "**/*.rs"),
            tool("t5", "WebFetch", "https://example.com"),
            tool("t6", "WebSearch", "rust axum"),
            with_detail("t7", "Agent", "Explore code", "Find the parser"),
            tool("t8", "Skill", "review"),
            with_detail("t9", "ExitPlanMode", "", "1. 写测试"),
            tool("t10", "mcp__codeg-mcp__ask_user_question", "codeg-mcp · ask_user_question"),
            tool("t11", "Monitor", "tail -f log"),
            tool("t12", "Edit", "/etc/hosts"),
            tool("t13", "ToolSearch", ""),
        ])
    );
}

#[test]
fn thinking_keeps_its_duration() {
    let mut line = assistant(json!([{"type":"thinking","thinking":"","signature":"s"}]));
    line["thinkingDurationMs"] = json!(2500);
    assert_eq!(
        events(&[line]),
        json!([{"kind":"thinking","uuid":"a1","at":AT,"ms":2500}])
    );
}

#[test]
fn tool_results_are_shaped_per_tool() {
    let hunk = |old_start: u64, lines: Vec<String>| json!({"oldStart":old_start,"oldLines":100,"newStart":old_start,"newLines":100,"lines":lines});
    let first = (0..100)
        .map(|index| format!("-old{index}"))
        .chain((0..100).map(|index| format!("+new{index}")))
        .collect::<Vec<_>>();
    let second = (0..50)
        .map(|index| format!(" ctx{index}"))
        .chain((0..100).map(|index| format!("+add{index}")))
        .chain((0..50).map(|index| format!("-del{index}")))
        .collect::<Vec<_>>();
    let failure = format!("Exit code 1\n{}", "e".repeat(2000));
    let produced = events(&[
        tool("b1", "Bash", json!({"command":"cargo build"})),
        result(
            "b1",
            json!("ignored"),
            Some(false),
            json!({"stdout":"x".repeat(3500),"stderr":"\u{1b}[31mwarn\u{1b}[0m\n","interrupted":false}),
        ),
        result(
            "b2",
            json!(failure),
            Some(true),
            json!("Error: Exit code 1"),
        ),
        tool("e1", "Edit", json!({"file_path":"/work/app/a.rs"})),
        result(
            "e1",
            json!("The file has been updated."),
            None,
            json!({"filePath":"/work/app/a.rs","structuredPatch":[hunk(1, first.clone()), hunk(300, second.clone())]}),
        ),
        tool("w1", "Write", json!({"file_path":"/work/app/new.txt"})),
        result(
            "w1",
            json!("File created"),
            None,
            json!({"type":"create","filePath":"/work/app/new.txt","content":"第一行\r\n第二行\n","structuredPatch":[]}),
        ),
        tool("r2", "Read", json!({"file_path":"/work/app/logo.png"})),
        result(
            "r2",
            json!([{"type":"image","source":{"type":"base64","data":"AAAA"}}]),
            None,
            json!({"type":"image","file":{"base64":"AAAA"}}),
        ),
        result(
            "r3",
            json!("1\tfn main() {}\n<system-reminder>check</system-reminder>"),
            None,
            json!({"type":"text","file":{"filePath":"/work/app/src/main.rs","content":"fn main() {}"}}),
        ),
        tool("s1", "WebSearch", json!({"query":"q"})),
        result(
            "s1",
            json!([{"type":"text","text":"Found 3 results\n<system-reminder>x</system-reminder>"}]),
            None,
            json!({"query":"q","results":[]}),
        ),
        result(
            "u9",
            json!("output"),
            None,
            json!({"stdout":"\u{1b}[1mbuilt\u{1b}[0m","stderr":"","interrupted":false}),
        ),
    ]);
    let results = produced
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == "result")
        .collect::<Vec<_>>();
    assert_eq!(
        *results[0],
        json!({"kind":"result","uuid":"r1","at":AT,"id":"b1","ok":true,"text":format!("…{}\nwarn", "x".repeat(2995))})
    );
    assert_eq!(
        *results[1],
        json!({"kind":"result","uuid":"r1","at":AT,"id":"b2","ok":false,"text":format!("{}…", &failure[..1500])})
    );
    assert_eq!(
        *results[2],
        json!({
            "kind":"result","uuid":"r1","at":AT,"id":"e1","ok":true,
            "diff":[hunk(1, first), hunk(300, second[..100].to_vec())],
            "added":200,"removed":150,"truncated":true
        })
    );
    assert_eq!(
        *results[3],
        json!({
            "kind":"result","uuid":"r1","at":AT,"id":"w1","ok":true,
            "diff":[{"oldStart":0,"oldLines":0,"newStart":1,"newLines":2,"lines":["+第一行","+第二行"]}],
            "added":2,"removed":0
        })
    );
    assert_eq!(
        *results[4],
        json!({"kind":"result","uuid":"r1","at":AT,"id":"r2","ok":true,"image":true,"images":1})
    );
    assert_eq!(
        *results[5],
        json!({"kind":"result","uuid":"r1","at":AT,"id":"r3","ok":true})
    );
    assert_eq!(
        *results[6],
        json!({"kind":"result","uuid":"r1","at":AT,"id":"s1","ok":true,"text":"Found 3 results"})
    );
    assert_eq!(
        *results[7],
        json!({"kind":"result","uuid":"r1","at":AT,"id":"u9","ok":true,"text":"built"})
    );
    assert_eq!(results.len(), 8);

    // 新建檔案超過 300 行時只保留開頭，增加行數仍以全文計算。
    let content = (0..450)
        .map(|index| format!("line{index}\n"))
        .collect::<String>();
    let big = events(&[result(
        "w2",
        json!("File created"),
        None,
        json!({"type":"create","content":content,"structuredPatch":[]}),
    )]);
    assert_eq!(big[0]["diff"][0]["lines"].as_array().unwrap().len(), 300);
    assert_eq!(big[0]["diff"][0]["newLines"], 450);
    assert_eq!(big[0]["added"], 450);
    assert_eq!(big[0]["truncated"], true);
}

#[test]
fn diffs_stop_at_the_total_character_budget() {
    // 300 行、每行超過 2000 字：每行先截到 2000 字，合計再截到 DIFF_TEXT 字；放不下的那一行
    // 保留開頭的 + 並以「…」收尾，之後的行不再保留。增加行數仍以全文計算。
    let lines = (0..300)
        .map(|_| format!("+{}", "長".repeat(2_500)))
        .collect::<Vec<_>>();
    let produced = events(&[
        tool("e1", "Edit", json!({"file_path":"/work/app/a.rs"})),
        result(
            "e1",
            json!("ok"),
            None,
            json!({"structuredPatch":[{"oldStart":1,"oldLines":0,"newStart":1,"newLines":300,"lines":lines}]}),
        ),
    ]);
    let event = &produced[1];
    let shown = event["diff"][0]["lines"].as_array().unwrap();
    let chars = shown
        .iter()
        .map(|line| line.as_str().unwrap().chars().count())
        .collect::<Vec<_>>();
    assert_eq!(chars.iter().sum::<usize>(), DIFF_TEXT + 1);
    assert_eq!(shown.len(), 32);
    assert!(chars[..31].iter().all(|count| *count == 2_001));
    let last = shown[31].as_str().unwrap();
    assert!(last.starts_with('+') && last.ends_with('…'));
    assert_eq!(
        (&event["added"], &event["removed"], &event["truncated"]),
        (&json!(300), &json!(0), &json!(true))
    );

    // 大量沒有內容的段落：最多保留 DIFF_HUNKS 段。
    let empty = (0..1_000)
        .map(
            |index| json!({"oldStart":index,"oldLines":0,"newStart":index,"newLines":0,"lines":[]}),
        )
        .collect::<Vec<_>>();
    let produced = events(&[result(
        "e2",
        json!("ok"),
        None,
        json!({"filePath":"/work/app/b.rs","structuredPatch":empty}),
    )]);
    assert_eq!(produced[0]["diff"].as_array().unwrap().len(), DIFF_HUNKS);
    assert_eq!(produced[0]["truncated"], true);

    // 新建的大檔案同樣受總字元數限制。
    let content = format!("{}\n", "x".repeat(1_000)).repeat(200);
    let produced = events(&[result(
        "w1",
        json!("File created"),
        None,
        json!({"type":"create","content":content,"structuredPatch":[]}),
    )]);
    let shown = produced[0]["diff"][0]["lines"].as_array().unwrap();
    let total = shown
        .iter()
        .map(|line| line.as_str().unwrap().chars().count())
        .sum::<usize>();
    assert!(total <= DIFF_TEXT + 1, "{total}");
    assert_eq!(
        (&produced[0]["added"], &produced[0]["truncated"]),
        (&json!(200), &json!(true))
    );
}

#[test]
fn task_tools_become_task_events_only() {
    assert_eq!(
        events(&[
            tool(
                "t1",
                "TaskCreate",
                json!({"subject":"写测试","description":"补齐"})
            ),
            result(
                "t1",
                json!("Task #1 created"),
                None,
                json!({"task":{"id":"1","subject":"写测试"}})
            ),
            tool(
                "t2",
                "TaskUpdate",
                json!({"taskId":"1","status":"completed"})
            ),
            result(
                "t2",
                json!("Updated"),
                None,
                json!({"success":true,"taskId":"1","updatedFields":["status"],"statusChange":{"from":"pending","to":"completed"}}),
            ),
            tool("t3", "TaskList", json!({})),
            result(
                "t3",
                json!("1 task"),
                None,
                json!({"tasks":[{"id":"1","subject":"写测试","status":"completed","blockedBy":[]}]}),
            ),
            tool(
                "t4",
                "TodoWrite",
                json!({"todos":[{"content":"读代码","status":"completed","activeForm":"读代码中"},{"content":"改代码","status":"in_progress","activeForm":"改代码中"}]}),
            ),
            result(
                "t4",
                json!("ok"),
                None,
                json!({"oldTodos":[],"newTodos":[]})
            ),
            // 呼叫在更早的視窗時，依結果結構辨識，同樣不產生工具結果。
            result(
                "t5",
                json!("Updated"),
                None,
                json!({"success":true,"taskId":"2","updatedFields":["subject"]})
            ),
            result(
                "t6",
                json!("Task #3 created"),
                None,
                json!({"task":{"id":"3","subject":"发布"}})
            ),
        ]),
        json!([
            {"kind":"task","at":AT,"op":"create","id":"1","subject":"写测试"},
            {"kind":"task","at":AT,"op":"update","id":"1","status":"completed"},
            {"kind":"tasks","at":AT,"items":[{"id":"1","subject":"写测试","status":"completed"}]},
            {"kind":"tasks","at":AT,"items":[
                {"id":"0","subject":"读代码","status":"completed"},
                {"id":"1","subject":"改代码","status":"in_progress"}
            ]},
            {"kind":"task","at":AT,"op":"create","id":"3","subject":"发布"},
        ])
    );
}

#[test]
fn labels_and_task_lists_are_bounded() {
    let long = |prefix: &str| format!("{prefix}{}", "z".repeat(1_000));
    let todos = (0..150)
        .map(|index| json!({"content":long(&format!("步驟{index}")),"status":long("s")}))
        .collect::<Vec<_>>();
    let mut reply = tool(&long("id"), &long("name"), json!({"x":"y"}));
    reply["uuid"] = json!(long("uuid"));
    reply["message"]["model"] = json!(long("model"));
    reply["message"]["content"]
        .as_array_mut()
        .unwrap()
        .insert(0, json!({"type":"text","text":"好"}));
    let produced = events(&[
        tool("t1", "TodoWrite", json!({ "todos": todos })),
        tool(
            "t2",
            "TaskUpdate",
            json!({"taskId":long("task"),"status":long("s"),"subject":long("標題")}),
        ),
        reply,
        result(&long("id"), json!("done"), None, json!({})),
        json!({"type":"permission-mode","permissionMode":long("mode")}),
    ]);
    let chars = |value: &Value| value.as_str().unwrap().chars().count();
    let items = produced[0]["items"].as_array().unwrap();
    assert_eq!(items.len(), TASK_ITEMS);
    assert_eq!(chars(&items[0]["subject"]), TASK_TEXT + 1);
    assert_eq!(chars(&items[0]["status"]), LABEL_TEXT + 1);
    assert!(items[0]["subject"].as_str().unwrap().starts_with("步驟0"));
    let task = &produced[1];
    assert_eq!(
        (
            chars(&task["id"]),
            chars(&task["status"]),
            chars(&task["subject"])
        ),
        (LABEL_TEXT, LABEL_TEXT + 1, TASK_TEXT + 1)
    );
    let (text, call, output, mode) = (&produced[2], &produced[3], &produced[4], &produced[5]);
    assert_eq!(text["kind"], "assistant");
    assert_eq!(
        (chars(&text["uuid"]), chars(&text["model"])),
        (LABEL_TEXT, LABEL_TEXT + 1)
    );
    assert_eq!(
        (chars(&call["id"]), chars(&call["name"])),
        (LABEL_TEXT, LABEL_TEXT + 1)
    );
    assert!(call["id"].as_str().unwrap().starts_with("idzzz"));
    // 超長的 ID 截斷後，工具事件與它的結果仍然對得上。
    assert_eq!(output["kind"], "result");
    assert_eq!(output["id"], call["id"]);
    assert_eq!(mode["kind"], "mode");
    assert_eq!(chars(&mode["value"]), LABEL_TEXT + 1);
}

#[test]
fn system_metadata_and_queued_lines() {
    let queued = |attachment: Value| json!({"type":"attachment","uuid":"q1","timestamp":T,"attachment":attachment});
    let mut meta_queued =
        queued(json!({"type":"queued_command","prompt":"内部","commandMode":"prompt"}));
    meta_queued["isMeta"] = json!(true);
    assert_eq!(
        events(&[
            json!({"type":"ai-title","aiTitle":"修复登录","sessionId":"x"}),
            // 相同的標題與模式重複寫入時只送出一次。
            json!({"type":"ai-title","aiTitle":"修复登录","sessionId":"x"}),
            json!({"type":"summary","summary":"Old summary","leafUuid":"y"}),
            system("turn_duration", json!({"durationMs":1234,"messageCount":5})),
            system("compact_boundary", json!({"content":"Conversation compacted"})),
            system("api_error", json!({"error":{"message":"Overloaded","status":529,"formatted":"529 Overloaded"},"retryInMs":1500,"retryAttempt":1,"maxRetries":10})),
            system("api_error", json!({"error":{"error":{"error":{"message":"nested"}}}})),
            system("api_error", json!({"error":"socket hang up"})),
            system("api_error", json!({"error":{"message":"m".repeat(400)}})),
            system("away_summary", json!({"content":"回来了：完成两项"})),
            system("informational", json!({"content":"Ran 3 hooks"})),
            system("model_refusal_fallback", json!({"content":"Switched model"})),
            system("stop_hook_summary", json!({"hookCount":1})),
            user(json!("<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n<summary>Background command \"npm test\" completed (exit code 0)</summary>\n</task-notification>\nRead the output file to retrieve the result: /tmp/x")),
            user(json!("<task-notification>\nBackground shell finished\n</task-notification>")),
            json!({"type":"cost-state","totalCostUSD":1.25,"totalLinesAdded":10,"totalLinesRemoved":2,"totalDuration":60000,"totalAPIDuration":1}),
            json!({"type":"permission-mode","permissionMode":"auto","sessionId":"x"}),
            json!({"type":"permission-mode","permissionMode":"auto","sessionId":"x"}),
            json!({"type":"permission-mode","permissionMode":"default","sessionId":"x"}),
            queued(json!({"type":"queued_command","prompt":"顺便更新 README","commandMode":"prompt"})),
            queued(json!({"type":"queued_command","prompt":[{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]})),
            queued(json!({"type":"queued_command","prompt":"同伴消息","isMeta":true})),
            meta_queued,
            queued(json!({"type":"queued_command","prompt":"<task-notification><summary>Agent finished</summary></task-notification>","commandMode":"task-notification"})),
            queued(json!({"type":"edited_text_file","filename":"x"})),
            json!({"type":"last-prompt","lastPrompt":"x"}),
            json!({"type":"file-history-snapshot","snapshot":{}}),
        ]),
        json!([
            {"kind":"title","text":"修复登录"},
            {"kind":"title","text":"Old summary"},
            {"kind":"turn","at":AT,"ms":1234,"messages":5},
            {"kind":"compact","at":AT},
            {"kind":"error","at":AT,"text":"Overloaded","retryInMs":1500,"attempt":1,"max":10},
            {"kind":"error","at":AT,"text":"nested"},
            {"kind":"error","at":AT,"text":"socket hang up"},
            {"kind":"error","at":AT,"text":format!("{}…", "m".repeat(300))},
            {"kind":"notice","at":AT,"text":"回来了：完成两项"},
            {"kind":"notice","at":AT,"text":"Ran 3 hooks"},
            {"kind":"notice","at":AT,"text":"Switched model"},
            {"kind":"notice","at":AT,"text":"Background command \"npm test\" completed (exit code 0)"},
            {"kind":"notice","at":AT,"text":"Background shell finished"},
            {"kind":"cost","usd":1.25,"added":10,"removed":2,"ms":60000},
            {"kind":"mode","value":"auto"},
            {"kind":"mode","value":"default"},
            {"kind":"queued","at":AT,"text":"顺便更新 README"},
            {"kind":"queued","at":AT,"text":"第一段\n\n第二段"},
            {"kind":"notice","at":AT,"text":"Agent finished"},
        ])
    );
}

#[test]
fn invalid_and_oversized_lines_are_skipped() {
    let mut parser = Parser::new(None);
    let mut out = Vec::new();
    parser.line(b"{not json", &mut out);
    parser.line(b"[1,2,3]", &mut out);
    parser.line(b"{\"type\":\"user\"}", &mut out);
    parser.line(b"{\"type\":\"mystery\",\"text\":\"x\"}", &mut out);
    assert!(out.is_empty());
}

fn prompt_line(index: usize) -> String {
    format!(
        "{}\n",
        json!({"type":"user","uuid":format!("u{index}"),"timestamp":T,"message":{"content":format!("prompt {index}")}})
    )
}

fn texts(page: &Page) -> Vec<String> {
    page.events
        .iter()
        .map(|event| match event {
            Event::User { text, .. } => text.clone(),
            other => panic!("unexpected {other:?}"),
        })
        .collect()
}

#[test]
fn rewound_branches_are_hidden_and_reset_the_client() {
    let directory = TempDir::new("claude-rewound");
    let path = directory.path().join("rewound.jsonl");
    let line = |value: Value| format!("{value}\n");
    let ask = |uuid: &str, parent: Option<&str>, text: &str| {
        line(
            json!({"type":"user","uuid":uuid,"parentUuid":parent,"timestamp":T,"message":{"role":"user","content":text}}),
        )
    };
    let answer = |uuid: &str, parent: &str, text: &str| {
        line(
            json!({"type":"assistant","uuid":uuid,"parentUuid":parent,"timestamp":T,"message":{"id":uuid,"role":"assistant","content":[{"type":"text","text":text}]}}),
        )
    };
    let mut content = [
        ask("a", None, "first"),
        answer("b", "a", "one"),
        ask("c", Some("b"), "second"),
        answer("d", "c", "two"),
    ]
    .concat();
    fs::write(&path, &content).unwrap();
    let roomy = Limits {
        window: 1 << 20,
        catch_up: 1 << 20,
        line: 1 << 20,
        ..Limits::default()
    };
    let shown = |page: &Page| {
        page.events
            .iter()
            .filter_map(|event| match event {
                Event::User { text, .. } => Some(text.clone()),
                Event::Assistant { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let page = read(&path, Window::Tail, &roomy, None).unwrap();
    assert_eq!(shown(&page), ["first", "one", "second", "two"]);

    // 回退到「second」之前再問：前端手上的內容過時了，要重置，丟掉的分支不再出現。
    content.push_str(&ask("e", Some("b"), "again"));
    content.push_str(&answer("f", "e", "three"));
    fs::write(&path, &content).unwrap();
    let next = read(&path, Window::After(page.cursor), &roomy, None).unwrap();
    assert!(next.reset);
    assert_eq!(shown(&next), ["first", "one", "again", "three"]);
    // 重置之後的增量讀取照常。
    let later = read(&path, Window::After(next.cursor), &roomy, None).unwrap();
    assert!(!later.reset && later.events.is_empty());
}

#[test]
fn windows_follow_complete_lines_and_cursors() {
    let directory = TempDir::new("claude-windows");
    let path = directory.path().join("conversation.jsonl");
    let lines = (0..4).map(prompt_line).collect::<Vec<_>>();
    let mut offsets = Vec::new();
    let mut total = 0u64;
    for line in &lines {
        offsets.push(total);
        total += line.len() as u64;
    }
    let end = total;
    let next = prompt_line(4);
    let mut content = lines.concat();
    content.push_str(&next[..20]);
    fs::write(&path, &content).unwrap();
    let size = content.len() as u64;
    let roomy = Limits {
        window: 1 << 20,
        catch_up: 1 << 20,
        line: 1 << 20,
        ..Limits::default()
    };
    let read = |window: Window, limits: &Limits| read(&path, window, limits, None).unwrap();

    // 初始視窗：只到最後一個完整行，寫到一半的行留待下次。
    let page = read(Window::Tail, &roomy);
    assert_eq!(
        (page.start, page.cursor, page.size, page.more, page.reset),
        (0, end, size, false, false)
    );
    assert_eq!(
        texts(&page),
        ["prompt 0", "prompt 1", "prompt 2", "prompt 3"]
    );

    // 視窗起點落在行中間時往後對齊；剛好在行首則不動。
    let page = read(
        Window::Tail,
        &Limits {
            window: size - offsets[2] - 3,
            ..roomy
        },
    );
    assert_eq!(
        (page.start, page.cursor, page.more),
        (offsets[3], end, true)
    );
    assert_eq!(texts(&page), ["prompt 3"]);
    let page = read(
        Window::Tail,
        &Limits {
            window: size - offsets[2],
            ..roomy
        },
    );
    assert_eq!(page.start, offsets[2]);
    assert_eq!(texts(&page), ["prompt 2", "prompt 3"]);
    // 視窗比最後一行還短：從該行行首開始，分頁才會前進。
    let page = read(Window::Tail, &Limits { window: 3, ..roomy });
    assert_eq!((page.start, page.cursor), (offsets[3], end));
    assert_eq!(texts(&page), ["prompt 3"]);

    // 往前分頁。
    let page = read(
        Window::Before(offsets[3]),
        &Limits {
            window: offsets[3] - offsets[1],
            ..roomy
        },
    );
    assert_eq!(
        (page.start, page.cursor, page.more),
        (offsets[1], offsets[3], true)
    );
    assert_eq!(texts(&page), ["prompt 1", "prompt 2"]);
    let page = read(Window::Before(offsets[1]), &roomy);
    assert_eq!((page.start, page.cursor, page.more), (0, offsets[1], false));
    assert_eq!(texts(&page), ["prompt 0"]);
    let page = read(Window::Before(0), &roomy);
    assert_eq!(
        (page.start, page.cursor, page.more, page.events.len()),
        (0, 0, false, 0)
    );
    let page = read(Window::Before(size + 100), &roomy);
    assert_eq!((page.start, page.cursor), (0, end));
    assert_eq!(texts(&page).len(), 4);

    // 增量讀取。
    let page = read(Window::After(offsets[2]), &roomy);
    assert_eq!(
        (page.start, page.cursor, page.reset, page.more),
        (offsets[2], end, false, true)
    );
    assert_eq!(texts(&page), ["prompt 2", "prompt 3"]);
    let page = read(Window::After(end), &roomy);
    assert_eq!((page.start, page.cursor, page.events.len()), (end, end, 0));
    // 游標超過檔案大小（檔案被換過）或落後太多：回傳最新視窗並要求重置。
    let page = read(Window::After(size + 1), &roomy);
    assert_eq!((page.start, page.cursor, page.reset), (0, end, true));
    assert_eq!(texts(&page).len(), 4);
    let page = read(
        Window::After(0),
        &Limits {
            catch_up: end - 1,
            ..roomy
        },
    );
    assert!(page.reset);

    // 補完最後一行後，增量讀到新的一行。
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    std::io::Write::write_all(&mut file, &next.as_bytes()[20..]).unwrap();
    let page = read(Window::After(end), &roomy);
    assert_eq!((page.start, page.cursor), (end, end + next.len() as u64));
    assert_eq!(texts(&page), ["prompt 4"]);
}

#[test]
fn oversized_and_invalid_lines_in_files_are_skipped() {
    let directory = TempDir::new("claude-oversized");
    let path = directory.path().join("conversation.jsonl");
    let huge = format!(
        "{}\n",
        json!({"type":"user","timestamp":T,"message":{"content":"y".repeat(1000)}})
    );
    fs::write(
        &path,
        [
            prompt_line(0),
            "{not json\n".into(),
            "\n".into(),
            huge,
            prompt_line(1),
        ]
        .concat(),
    )
    .unwrap();
    let limits = Limits {
        window: 1 << 20,
        catch_up: 1 << 20,
        line: 300,
        ..Limits::default()
    };
    let page = read(&path, Window::Tail, &limits, None).unwrap();
    assert_eq!(texts(&page), ["prompt 0", "prompt 1"]);
}
