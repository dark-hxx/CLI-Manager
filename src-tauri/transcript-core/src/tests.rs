use super::*;
use crate::test_support::TempDir;
use serde_json::{json, Value};
use std::{fs, io::ErrorKind};

const T: &str = "2026-10-15T07:15:26.280Z";
const AT: u64 = 1_792_048_526_280;
const SESSION: &str = "0199e3a1-5d55-7c1d-9a39-2f1f0e3b7a11";

fn lines(values: &[Value]) -> String {
    values.iter().map(|value| format!("{value}\n")).collect()
}

fn claude_prompt(uuid: &str, text: &str) -> Value {
    json!({"type":"user","uuid":uuid,"timestamp":T,"message":{"role":"user","content":text}})
}

#[test]
fn transcript_serializes_the_web_contract() {
    let directory = TempDir::new("api-contract");
    let path = directory.path().join("claude.jsonl");
    let content = lines(&[claude_prompt("u1", "修复登录")]);
    fs::write(&path, &content).unwrap();
    let size = content.len() as u64;
    let page = transcript(
        Source::Claude,
        &path,
        Window::Tail,
        &web_limits(),
        Some("/work/app"),
        Some(SESSION.into()),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&page).unwrap(),
        json!({
            "parser":PARSER,"available":true,"agentSessionId":SESSION,"start":0,"cursor":size,"size":size,"more":false,
            "events":[{"kind":"user","uuid":"u1","at":AT,"text":"修复登录"}]
        })
    );
    // 游標之後沒有新內容：事件為空；游標超過檔案大小時改回最新視窗並要求重置。
    let next = transcript(
        Source::Claude,
        &path,
        Window::After(page.cursor),
        &web_limits(),
        None,
        None,
    )
    .unwrap();
    assert!(next.available && next.events.is_empty() && !next.reset);
    let reset = transcript(
        Source::Claude,
        &path,
        Window::After(size + 10),
        &web_limits(),
        None,
        None,
    )
    .unwrap();
    let value = serde_json::to_value(&reset).unwrap();
    assert_eq!(
        (&value["reset"], &value["cursor"]),
        (&json!(true), &json!(size))
    );
    assert!(value.get("agentSessionId").is_none() && value.get("reason").is_none());
}

#[test]
fn unavailable_keeps_the_reason_and_session() {
    assert_eq!(
        serde_json::to_value(Transcript::unavailable("missing", Some(SESSION.into()))).unwrap(),
        json!({"parser":PARSER,"available":false,"reason":"missing","agentSessionId":SESSION,"start":0,"cursor":0,"size":0,"more":false,"events":[]})
    );
    assert_eq!(
        serde_json::to_value(Transcript::unavailable("unbound", None)).unwrap(),
        json!({"parser":PARSER,"available":false,"reason":"unbound","start":0,"cursor":0,"size":0,"more":false,"events":[]})
    );
}

#[test]
fn read_dispatches_by_source() {
    let directory = TempDir::new("api-source");
    let claude = directory.path().join("claude.jsonl");
    let codex = directory.path().join("rollout.jsonl");
    fs::write(&claude, lines(&[claude_prompt("u1", "Claude 的提問")])).unwrap();
    fs::write(
        &codex,
        lines(&[
            json!({"timestamp":T,"type":"session_meta","payload":{"id":SESSION,"cwd":"/work/app"}}),
            json!({"timestamp":T,"type":"event_msg","payload":{"type":"user_message","message":"Codex 的提問"}}),
        ]),
    )
    .unwrap();
    let texts = |source: Source, path: &Path| {
        read(source, path, Window::Tail, &web_limits(), None)
            .unwrap()
            .events
            .into_iter()
            .filter_map(|event| match event {
                Event::User { text, .. } => Some(text),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(texts(Source::Claude, &claude), ["Claude 的提問"]);
    assert_eq!(texts(Source::Codex, &codex), ["Codex 的提問"]);
    // 同一份 Codex 紀錄用 Claude 的規則讀不出任何提問，反之亦然。
    assert!(texts(Source::Claude, &codex).is_empty());
    assert!(texts(Source::Codex, &claude).is_empty());
    // 檔案不存在時傳回 NotFound，由主機端改回 unavailable。
    let missing = directory.path().join("missing.jsonl");
    let error = transcript(
        Source::Codex,
        &missing,
        Window::Tail,
        &web_limits(),
        None,
        None,
    )
    .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::NotFound);
}

#[test]
fn web_limits_bound_the_output_instead_of_the_raw_read() {
    assert_eq!(
        web_limits(),
        Limits {
            window: 4 * 1024 * 1024,
            catch_up: 8 * 1024 * 1024,
            line: 8 * 1024 * 1024,
            output: 512 * 1024,
            position_keys: true,
        }
    );
    assert_eq!(Limits::default().window, WINDOW);
    assert_eq!(Limits::default().output, usize::MAX);
}

#[test]
fn oversized_records_still_fit_one_web_result() {
    // 一則貼了大量文字的提問、一個改了整份大檔案的修改：原始紀錄都超過單次結果的上限，
    // 整理出的事件仍各自有上界，整頁序列化後低於 700 KiB。
    let directory = TempDir::new("api-bounded");
    let path = directory.path().join("claude.jsonl");
    let diff = (0..300)
        .map(|_| format!("+{}", "長".repeat(3_000)))
        .collect::<Vec<_>>();
    let content = lines(&[
        claude_prompt("u1", &"字".repeat(100_000)),
        json!({"type":"assistant","uuid":"a1","timestamp":T,"message":{"model":"claude-test","content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"/work/app/a.rs"}}]}}),
        json!({"type":"user","uuid":"r1","timestamp":T,"message":{"content":[{"type":"tool_result","tool_use_id":"e1","content":"ok"}]},"toolUseResult":{"structuredPatch":[{"oldStart":1,"oldLines":0,"newStart":1,"newLines":300,"lines":diff}]}}),
    ]);
    fs::write(&path, &content).unwrap();
    let limits = Limits {
        window: content.len() as u64,
        ..web_limits()
    };
    let page = transcript(Source::Claude, &path, Window::Tail, &limits, None, None).unwrap();
    assert_eq!(page.start, 0);
    let kinds = page
        .events
        .iter()
        .map(|event| serde_json::to_value(event).unwrap()["kind"].clone())
        .collect::<Vec<_>>();
    assert_eq!(kinds, ["user", "tool", "status", "result"]);
    let bytes = serde_json::to_vec(&page).unwrap().len();
    assert!(content.len() > 2 * 1024 * 1024, "{}", content.len());
    assert!(bytes < 700 * 1024, "{bytes}");
}

#[test]
fn read_window_maps_sources_cursors_and_missing_files() {
    let directory = TempDir::new("api-read-window");
    let path = directory.path().join("claude.jsonl");
    fs::write(&path, lines(&[claude_prompt("u1", "修复登录")])).unwrap();
    let unsupported = read_window("gemini", &path, None, None, None, Some(SESSION.into())).unwrap();
    assert_eq!(
        (unsupported.available, unsupported.reason),
        (false, Some("unsupported"))
    );
    let missing = directory.path().join("absent.jsonl");
    let missing = read_window("claude", &missing, None, None, None, Some(SESSION.into())).unwrap();
    assert_eq!(
        (missing.available, missing.reason),
        (false, Some("missing"))
    );
    assert_eq!(missing.agent_session_id.as_deref(), Some(SESSION));
    assert!(read_window("claude", &path, Some(1), Some(2), None, None).is_err());

    let tail = read_window("claude", &path, None, None, None, None).unwrap();
    assert!(tail.available && tail.events.len() == 1);
    let next = read_window("claude", &path, Some(tail.cursor), None, None, None).unwrap();
    assert!(next.events.is_empty() && !next.reset);
}

/// 每行一則提問的紀錄，傳回內容與各行行首的位置。
fn prompts(count: usize, chars: usize) -> (String, Vec<u64>) {
    let mut content = String::new();
    let mut offsets = Vec::new();
    for index in 0..count {
        offsets.push(content.len() as u64);
        content.push_str(&format!(
            "{}\n",
            claude_prompt(&format!("u{index}"), &"a".repeat(chars))
        ));
    }
    (content, offsets)
}

fn uuids(page: &Transcript) -> Vec<String> {
    page.events
        .iter()
        .map(|event| {
            serde_json::to_value(event).unwrap()["uuid"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

fn budget(output: usize) -> Limits {
    Limits {
        output,
        ..web_limits()
    }
}

#[test]
fn incremental_reads_stop_at_the_output_budget_and_resume_without_gaps() {
    let directory = TempDir::new("api-output-incremental");
    let path = directory.path().join("claude.jsonl");
    let (content, _) = prompts(50, 1_000);
    fs::write(&path, &content).unwrap();
    let size = content.len() as u64;
    let mut cursor = 0;
    let mut seen = Vec::new();
    let mut pages = 0;
    while cursor < size {
        let page = transcript(
            Source::Claude,
            &path,
            Window::After(cursor),
            &budget(10_000),
            None,
            None,
        )
        .unwrap();
        assert!(
            !page.reset && page.cursor > cursor,
            "the cursor must advance"
        );
        assert!(serde_json::to_vec(&page.events).unwrap().len() <= 10_000);
        assert_eq!(page.partial, page.cursor < size);
        seen.extend(uuids(&page));
        cursor = page.cursor;
        pages += 1;
    }
    assert!(pages > 1, "{pages}");
    assert_eq!(
        seen,
        (0..50).map(|index| format!("u{index}")).collect::<Vec<_>>()
    );
}

#[test]
fn windows_keep_the_newest_lines_within_the_output_budget_and_page_back_seamlessly() {
    let directory = TempDir::new("api-output-window");
    let path = directory.path().join("claude.jsonl");
    let (content, offsets) = prompts(50, 1_000);
    fs::write(&path, &content).unwrap();
    let tail = transcript(
        Source::Claude,
        &path,
        Window::Tail,
        &budget(10_000),
        None,
        None,
    )
    .unwrap();
    let kept = uuids(&tail);
    assert!(!kept.is_empty() && kept.len() < 50);
    assert_eq!(kept.last().map(String::as_str), Some("u49"));
    let first: usize = kept[0][1..].parse().unwrap();
    assert_eq!(tail.start, offsets[first]);
    assert!(tail.more && tail.cursor == content.len() as u64);
    assert!(serde_json::to_vec(&tail.events).unwrap().len() <= 10_000);

    let older = transcript(
        Source::Claude,
        &path,
        Window::Before(tail.start),
        &budget(10_000),
        None,
        None,
    )
    .unwrap();
    let previous = uuids(&older);
    assert_eq!(previous.last(), Some(&format!("u{}", first - 1)));
    // 往前一頁同樣裁切：起點落在它保留的第一行的行首。
    let older_first: usize = previous[0][1..].parse().unwrap();
    assert_eq!(older.start, offsets[older_first]);
    assert!(serde_json::to_vec(&older.events).unwrap().len() <= 10_000);
}

#[test]
fn a_single_line_over_the_output_budget_still_makes_progress() {
    let directory = TempDir::new("api-output-single");
    let path = directory.path().join("claude.jsonl");
    let (content, offsets) = prompts(3, 1_000);
    fs::write(&path, &content).unwrap();
    let page = transcript(
        Source::Claude,
        &path,
        Window::After(0),
        &budget(10),
        None,
        None,
    )
    .unwrap();
    // 預算小到連一個事件都放不下：那一行只剩提示，游標照樣越過它。
    assert_eq!(notice_codes(&page), [Some("line_truncated".to_string())]);
    assert_eq!(page.cursor, offsets[1]);
    let tail = transcript(Source::Claude, &path, Window::Tail, &budget(10), None, None).unwrap();
    assert_eq!(notice_codes(&tail), [Some("line_truncated".to_string())]);
    assert_eq!(tail.start, offsets[2]);
}

/// 每個事件的種類為 notice 時取它的代碼，其他事件為 None。
fn notice_codes(page: &Transcript) -> Vec<Option<String>> {
    page.events
        .iter()
        .map(|event| {
            let value = serde_json::to_value(event).unwrap();
            (value["kind"] == "notice")
                .then(|| value["code"].as_str().unwrap_or_default().to_string())
        })
        .collect()
}

#[test]
fn a_task_list_at_its_field_limits_is_shrunk_to_fit_the_budget() {
    // 複審時構造的最壞情況：100 項任務、每個欄位都塞滿需要跳脫的字元，單一事件就超過 512 KiB。
    let directory = TempDir::new("api-output-tasks");
    let path = directory.path().join("claude.jsonl");
    let noisy = |count: usize| "\u{1}".repeat(count);
    let tasks = (0..100)
        .map(|index| json!({"id":format!("{index}{}", noisy(300)),"subject":noisy(600),"status":noisy(300)}))
        .collect::<Vec<_>>();
    let content = lines(&[
        json!({"type":"user","uuid":"r1","timestamp":T,"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"toolUseResult":{"tasks":tasks}}),
    ]);
    fs::write(&path, &content).unwrap();
    let unbounded = transcript(
        Source::Claude,
        &path,
        Window::Tail,
        &budget(usize::MAX),
        None,
        None,
    )
    .unwrap();
    assert!(serde_json::to_vec(&unbounded.events).unwrap().len() > WEB_OUTPUT);

    for window in [Window::Tail, Window::After(0)] {
        let page = transcript(Source::Claude, &path, window, &web_limits(), None, None).unwrap();
        assert!(serde_json::to_vec(&page.events).unwrap().len() <= WEB_OUTPUT);
        assert_eq!(page.cursor, content.len() as u64);
        let tasks = page
            .events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .find(|event| event["kind"] == "tasks")
            .expect("the shrunk task list is still shown");
        assert_eq!(tasks["items"].as_array().unwrap().len(), SHRUNK_TASKS);
    }
}

#[test]
fn events_without_uuid_get_position_keys_that_survive_paging() {
    let directory = TempDir::new("api-position-keys");
    let path = directory.path().join("claude.jsonl");
    let bare =
        |text: &str| json!({"type":"user","timestamp":T,"message":{"role":"user","content":text}});
    let first = format!("{}\n", bare("a"));
    let content = first.clone() + &lines(&[claude_prompt("u2", "b"), bare("c")]);
    fs::write(&path, &content).unwrap();
    let third = content.len() - format!("{}\n", bare("c")).len();

    let tail = transcript(
        Source::Claude,
        &path,
        Window::Tail,
        &web_limits(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        uuids(&tail),
        ["pos:0:0".to_string(), "u2".into(), format!("pos:{third}:0")]
    );
    let older = transcript(
        Source::Claude,
        &path,
        Window::Before(third as u64),
        &web_limits(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(uuids(&older), ["pos:0:0", "u2"]);
    // 一般讀取（非網頁端）不補 key。
    let plain = transcript(
        Source::Claude,
        &path,
        Window::Tail,
        &Limits::default(),
        None,
        None,
    )
    .unwrap();
    assert!(serde_json::to_value(&plain.events[0])
        .unwrap()
        .get("uuid")
        .is_none());
}

#[test]
fn a_single_line_over_the_budget_is_degraded_instead_of_blocking_reads() {
    let directory = TempDir::new("api-output-degrade");
    let path = directory.path().join("claude.jsonl");
    let diff = (0..300)
        .map(|index| format!("+line {index} {}", "x".repeat(200)))
        .collect::<Vec<_>>();
    let call = format!(
        "{}\n",
        json!({"type":"assistant","uuid":"a1","timestamp":T,"message":{"model":"claude-test","content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"/work/app/a.rs"}}]}})
    );
    let result = format!(
        "{}\n",
        json!({"type":"user","uuid":"r1","timestamp":T,"message":{"content":[{"type":"tool_result","tool_use_id":"e1","content":"ok"}]},"toolUseResult":{"structuredPatch":[{"oldStart":1,"oldLines":0,"newStart":1,"newLines":300,"lines":diff}]}})
    );
    fs::write(&path, call.clone() + &result).unwrap();
    let size = (call.len() + result.len()) as u64;

    // 不限總量時 diff 完整保留，可見這一行本身就超過下面的預算。
    let full = transcript(
        Source::Claude,
        &path,
        Window::After(call.len() as u64),
        &budget(usize::MAX),
        None,
        None,
    )
    .unwrap();
    assert!(serde_json::to_vec(&full.events).unwrap().len() > 10_000);

    let page = transcript(
        Source::Claude,
        &path,
        Window::After(call.len() as u64),
        &budget(10_000),
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        page.cursor, size,
        "the read must advance past the oversized line"
    );
    assert!(!page.partial);
    let result = page
        .events
        .iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .find(|event| event["kind"] == "result")
        .unwrap();
    assert!(result.get("diff").is_none());
    assert_eq!(result["truncated"], true);
    assert_eq!(result["added"], 300);
    assert!(serde_json::to_vec(&page.events).unwrap().len() <= 10_000);
}

#[test]
fn a_codex_patch_touching_many_large_files_still_fits_one_web_result() {
    // 審查時重現的情境：一次修補新增 12 份大型中文文件，那一行整理出的事件約 880 KB，
    // 超過單次結果的上限；降級後必須送得出去，讀取也要前進。
    let directory = TempDir::new("api-codex-patch");
    let path = directory.path().join("rollout.jsonl");
    let body = (0..300)
        .map(|_| format!("+{}\n", "中".repeat(80)))
        .collect::<String>();
    let files = (0..12)
        .map(|index| format!("*** Add File: docs/{index}.md\n{body}"))
        .collect::<String>();
    let patch = format!("*** Begin Patch\n{files}*** End Patch\n");
    let line = |kind: &str, payload: Value| json!({"timestamp":T,"type":kind,"payload":payload});
    let content = lines(&[
        line("turn_context", json!({"cwd":"/work/app"})),
        line(
            "response_item",
            json!({"type":"custom_tool_call","name":"apply_patch","call_id":"p1","status":"completed","input":patch}),
        ),
        line(
            "response_item",
            json!({"type":"custom_tool_call_output","call_id":"p1","output":"Success."}),
        ),
    ]);
    fs::write(&path, &content).unwrap();
    let unbounded = transcript(
        Source::Codex,
        &path,
        Window::Tail,
        &budget(usize::MAX),
        None,
        None,
    )
    .unwrap();
    assert!(
        serde_json::to_vec(&unbounded).unwrap().len() > WEB_OUTPUT,
        "the scenario must exceed the budget"
    );

    for window in [Window::Tail, Window::After(0)] {
        let page = transcript(Source::Codex, &path, window, &web_limits(), None, None).unwrap();
        assert_eq!(page.cursor, content.len() as u64);
        assert!(serde_json::to_vec(&page).unwrap().len() <= WEB_OUTPUT + 4 * 1024);
        let results = page
            .events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .filter(|event| event["kind"] == "result")
            .collect::<Vec<_>>();
        assert!(!results.is_empty());
        assert!(results
            .iter()
            .all(|result| result["uuid"].as_str().is_some()));
    }
}

#[test]
fn a_line_with_too_many_events_keeps_what_fits_and_still_advances() {
    // 舊版 Claude Code 把整則訊息寫成一行：一行裡有很多工具呼叫，逐一降級後仍超過預算。
    let directory = TempDir::new("api-output-many-events");
    let path = directory.path().join("claude.jsonl");
    let blocks = (0..30)
        .map(|index| json!({"type":"tool_use","id":format!("b{index}"),"name":"Bash","input":{"command":format!("echo {}", "y".repeat(3_000)),"description":"run"}}))
        .collect::<Vec<_>>();
    let content = lines(&[
        json!({"type":"assistant","uuid":"a1","timestamp":T,"message":{"model":"claude-test","content":blocks}}),
    ]);
    fs::write(&path, &content).unwrap();
    let full = transcript(
        Source::Claude,
        &path,
        Window::After(0),
        &budget(usize::MAX),
        None,
        None,
    )
    .unwrap();
    assert!(serde_json::to_vec(&full.events).unwrap().len() > 10_000);

    let page = transcript(
        Source::Claude,
        &path,
        Window::After(0),
        &budget(10_000),
        None,
        None,
    )
    .unwrap();
    assert_eq!(page.cursor, content.len() as u64);
    assert!(!page.partial);
    assert!(serde_json::to_vec(&page.events).unwrap().len() <= 10_000);
    let last = serde_json::to_value(page.events.last().unwrap()).unwrap();
    assert_eq!(
        (last["kind"].as_str(), last["code"].as_str()),
        (Some("notice"), Some("line_truncated"))
    );
    assert!(page.events.len() > 1 && page.events.len() < full.events.len());

    let tail = transcript(
        Source::Claude,
        &path,
        Window::Tail,
        &budget(10_000),
        None,
        None,
    )
    .unwrap();
    assert!(serde_json::to_vec(&tail.events).unwrap().len() <= 10_000);
}

#[test]
fn an_incremental_cursor_inside_a_line_starts_at_the_next_line() {
    let directory = TempDir::new("api-align-cursor");
    let path = directory.path().join("claude.jsonl");
    let (content, offsets) = prompts(3, 100);
    fs::write(&path, &content).unwrap();
    let page = transcript(
        Source::Claude,
        &path,
        Window::After(offsets[1] - 10),
        &web_limits(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(uuids(&page), ["u1", "u2"]);
    assert_eq!(page.cursor, content.len() as u64);
    // 行首的游標照舊。
    let page = transcript(
        Source::Claude,
        &path,
        Window::After(offsets[2]),
        &web_limits(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(uuids(&page), ["u2"]);
}

#[test]
fn events_primed_before_the_window_count_toward_the_page_budget() {
    // Codex 的最新一段與往前翻頁：預讀到的設定（模型）會在第一行之前放進一則 Status，也要算進預算。
    // 預算剛好等於視窗內每一行的事件大小總和：只看逐行就不必裁切，加上 Status 才會超過。
    let directory = TempDir::new("api-output-primed");
    let path = directory.path().join("rollout.jsonl");
    let line = |kind: &str, payload: Value| json!({"timestamp":T,"type":kind,"payload":payload});
    let context = format!(
        "{}\n",
        line(
            "turn_context",
            json!({"cwd":"/work/app","model":"gpt-5-codex","effort":"high"})
        )
    );
    let prompts = (0..40)
        .map(|index| {
            line(
                "event_msg",
                json!({"type":"user_message","message":format!("{index} {}", "z".repeat(300))}),
            )
        })
        .collect::<Vec<_>>();
    let content = context.clone() + &lines(&prompts);
    fs::write(&path, &content).unwrap();
    let size = content.len() as u64;
    let window = size - context.len() as u64;

    let unbounded = transcript(
        Source::Codex,
        &path,
        Window::Tail,
        &Limits {
            window,
            ..budget(usize::MAX)
        },
        None,
        None,
    )
    .unwrap();
    let (primed, prompts) = unbounded.events.split_first().unwrap();
    assert_eq!(serde_json::to_value(primed).unwrap()["kind"], "status");
    assert_eq!(prompts.len(), 40);
    let output: usize = prompts
        .iter()
        .map(|event| {
            serde_json::to_vec(std::slice::from_ref(event))
                .unwrap()
                .len()
        })
        .sum();

    let limits = Limits {
        window,
        ..budget(output)
    };
    for read in [Window::Tail, Window::Before(size)] {
        let page = transcript(Source::Codex, &path, read, &limits, None, None).unwrap();
        let bytes = serde_json::to_vec(&page.events).unwrap().len();
        assert!(
            bytes <= output,
            "{read:?} with budget {output} produced {bytes} bytes"
        );
        assert_eq!(
            page.events.len(),
            40,
            "every prompt fits once the primed status is dropped"
        );
    }
}

#[test]
fn a_cursor_inside_the_unterminated_last_line_waits_and_then_skips_that_line() {
    // 還在寫的最後一行沒有「下一個行首」可對齊：先什麼都不讀，游標不動；那一行寫完後照
    // 「行中游標對齊到下一個行首」越過它，之後的新行照常讀到。
    let directory = TempDir::new("api-align-unterminated");
    let path = directory.path().join("claude.jsonl");
    let first = format!("{}\n", claude_prompt("u0", "a"));
    let partial = claude_prompt("u1", "b").to_string();
    fs::write(&path, format!("{first}{partial}")).unwrap();
    let inside = (first.len() + 5) as u64;

    let waiting = transcript(
        Source::Claude,
        &path,
        Window::After(inside),
        &web_limits(),
        None,
        None,
    )
    .unwrap();
    assert!(waiting.events.is_empty() && !waiting.reset && !waiting.partial);
    assert_eq!(waiting.cursor, inside);

    let next = format!("{}\n", claude_prompt("u2", "c"));
    fs::write(&path, format!("{first}{partial}\n{next}")).unwrap();
    let page = transcript(
        Source::Claude,
        &path,
        Window::After(inside),
        &web_limits(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(uuids(&page), ["u2"]);
    assert_eq!(
        page.cursor,
        (first.len() + partial.len() + 1 + next.len()) as u64
    );
}
