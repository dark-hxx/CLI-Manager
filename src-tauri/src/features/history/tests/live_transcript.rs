use super::super::live_transcript_projection::{project, text_only};
use super::super::live_transcript_reader::Reader;
use super::*;
use std::time::Instant;

const ID: &str = "12345678-1234-4234-8234-123456789012";
const CWD: &str = "C:/synthetic-tap-project";

fn record(role: &str, text: &str) -> Value {
    json!({"type":role,"sessionId":ID,"cwd":CWD,"timestamp":"2026-10-26T00:00:00Z",
        "message":{"role":role,"content":[{"type":"text","text":text}]}})
}

fn write_lines(path: &Path, values: &[Value]) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    for value in values {
        writeln!(file, "{value}").unwrap();
    }
}

#[test]
fn live_transcript_canonical_differential_and_wire_fixture() {
    let temp = TempDir::new().unwrap();
    let mut fixtures = Vec::new();
    for source in ["claude", "codex"] {
        let path = temp.path().join(format!("{source}.jsonl"));
        let records = if source == "claude" {
            vec![
                record("user", "Inspect 🚀"),
                json!({"type":"assistant","message":{"role":"assistant","content":[
                {"type":"thinking","thinking":"public thought","signature":"NEVER_EXPORT"},
                {"type":"tool_use","id":"c1","name":"Bash","input":{"command":"git status"}},
                {"type":"text","text":"Interim"}]}}),
                json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"clean"}]}}),
                record("assistant", &("a".repeat(3999) + "🚀tail")),
            ]
        } else {
            vec![
                json!({"type":"session_meta","payload":{"id":ID,"cwd":CWD}}),
                json!({"type":"turn_context","payload":{"model":"gpt-5","effort":"high"}}),
                json!({"type":"response_item","timestamp":"2026-10-26T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Question"}]}}),
                json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"public thought"}],"encrypted_content":"NEVER_EXPORT"}}),
                json!({"type":"response_item","payload":{"type":"function_call","name":"shell_command","call_id":"c1","arguments":"{\"command\":\"git status\"}"}}),
                json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"clean"}}),
                json!({"type":"event_msg","payload":{"type":"agent_message","message":"NOT_CANONICAL"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}),
            ]
        };
        write_lines(&path, &records);
        let (_, _, canonical) = scan_session_detail(&path);
        let mut reader = Reader::new(ID, CWD);
        reader.update(&path, None).unwrap();
        for detailed in [false, true] {
            let page = reader.page(None, detailed, None);
            assert!(page.available);
            let expected: Vec<_> = canonical
                .iter()
                .enumerate()
                .filter_map(|(i, m)| project(ID, i, m))
                .filter_map(|m| if detailed { Some(m) } else { text_only(m) })
                .collect();
            assert_eq!(
                page.messages, expected,
                "source={source} detailed={detailed}"
            );
            assert!(!serde_json::to_string(&page)
                .unwrap()
                .contains("NEVER_EXPORT"));
            fixtures.push(json!({"canonical":canonical,"page":page,"detailed":detailed}));
        }
    }
    // Optional isolated cross-language check: Node compares these pages with the original TS projection.
    if let Ok(path) = std::env::var("TAP_TRANSCRIPT_FIXTURE") {
        fs::write(path, serde_json::to_vec(&fixtures).unwrap()).unwrap();
    }
}

#[test]
fn live_transcript_zero_idle_io_incremental_append_and_pagination_benchmark() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("long.jsonl");
    let values: Vec<_> = (0..20_000)
        .map(|i| {
            record(
                if i % 2 == 0 { "user" } else { "assistant" },
                &format!("line {i}: {}", "x".repeat(200)),
            )
        })
        .collect();
    write_lines(&path, &values);
    let start = Instant::now();
    let (_, _, canonical) = scan_session_detail(&path);
    let full_ms = start.elapsed().as_millis();
    let start = Instant::now();
    let mut reader = Reader::new(ID, CWD);
    reader.update(&path, None).unwrap();
    let cold_ms = start.elapsed().as_millis();
    let bytes = reader.read_bytes;
    let probes = reader.probe_bytes;
    let page = reader.page(None, true, None);
    assert_eq!(page.start, 19_960);
    assert_eq!(page.total, canonical.len());
    assert_eq!(page.messages.len(), 40);
    let start = Instant::now();
    for _ in 0..20 {
        assert!(!reader.update(&path, None).unwrap());
        assert!(reader.page(None, true, Some(&page.revision)).unchanged);
    }
    let idle_us = start.elapsed().as_micros();
    assert_eq!(
        reader.read_bytes, bytes,
        "unchanged file performs no body reads"
    );
    let append = record("assistant", "final delayed answer 🚀");
    assert_eq!(
        reader.probe_bytes, probes,
        "unchanged file performs no fingerprint reads"
    );
    write_lines(&path, &[append.clone()]);
    let start = Instant::now();
    reader.update(&path, None).unwrap();
    let append_us = start.elapsed().as_micros();
    let append_bytes = reader.read_bytes - bytes;
    let append_probe_bytes = reader.probe_bytes - probes;
    assert_eq!(
        append_bytes,
        serde_json::to_vec(&append).unwrap().len() as u64 + 1
    );
    assert_eq!(
        reader.page(None, true, None).messages.last().unwrap().text,
        "final delayed answer 🚀"
    );
    let older = reader.older(&path, 19_960, true).unwrap();
    assert_eq!(older.start, 19_920);
    assert_eq!(older.total, 20_001);
    assert_eq!(older.messages.last().unwrap().id, format!("{ID}:19959"));
    assert!(append_probe_bytes <= 320);
    println!("TAP_BENCH full_detail_ms={full_ms} cold_incremental_ms={cold_ms} file_bytes={bytes} idle_20_us={idle_us} append_us={append_us} append_body_bytes={append_bytes} append_fingerprint_bytes={append_probe_bytes}");
}

#[test]
fn live_transcript_half_utf8_tail_no_newline_and_reset_do_not_duplicate() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("partial.jsonl");
    write_lines(&path, &[record("user", "Question")]);
    let mut reader = Reader::new(ID, CWD);
    reader.update(&path, None).unwrap();
    let raw = serde_json::to_vec(&record("assistant", "🚀Answer")).unwrap();
    let split = raw.windows(4).position(|v| v == "🚀".as_bytes()).unwrap() + 2;
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&raw[..split]).unwrap();
    file.flush().unwrap();
    reader.update(&path, None).unwrap();
    assert_eq!(reader.page(None, true, None).total, 1);
    file.write_all(&raw[split..]).unwrap();
    file.flush().unwrap();
    reader.update(&path, None).unwrap();
    let page = reader.page(None, true, None);
    assert_eq!(page.total, 2);
    assert_eq!(page.messages.last().unwrap().text, "🚀Answer");
    file.write_all(b"\n").unwrap();
    file.flush().unwrap();
    reader.update(&path, None).unwrap();
    assert_eq!(
        reader.page(None, true, None).total,
        2,
        "completing a newline does not duplicate the provisional row"
    );
    drop(file);
    fs::write(&path, format!("{}\n", record("user", "Replacement"))).unwrap();
    reader.update(&path, None).unwrap();
    let reset = reader.page(None, true, Some(&page.revision));
    assert_ne!(page.epoch, reset.epoch);
    assert_eq!(reset.total, 1);
    assert_eq!(reset.messages[0].text, "Replacement");
    let mut foreign = Reader::new("different-id", CWD);
    foreign.update(&path, None).unwrap();
    assert!(!foreign.page(None, true, None).available);
    let mut foreign = Reader::new(ID, "C:/another-project");
    foreign.update(&path, None).unwrap();
    assert!(!foreign.page(None, true, None).available);
}

#[test]
fn live_transcript_wire_budget_preserves_source_cursor_and_omission() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("large.jsonl");
    let blocks: Vec<_> = (0..30).map(|i| json!({"type":"tool_use","name":"Bash","id":format!("c{i}"),"input":{"command":"\"".repeat(500)}})).collect();
    let value = json!({"type":"assistant","sessionId":ID,"cwd":CWD,"message":{"role":"assistant","content":blocks}});
    write_lines(&path, &vec![value; 80]);
    let mut reader = Reader::new(ID, CWD);
    reader.update(&path, None).unwrap();
    let page = reader.page(None, true, None);
    assert_eq!(page.total, 80);
    assert!(serde_json::to_vec(&page).unwrap().len() < 512 * 1024);
    assert!(page.start >= 40 && page.start < 80);
    assert!(page
        .messages
        .iter()
        .all(|m| m.parts_truncated == Some(true)));
    let older = reader.older(&path, page.start, true).unwrap();
    assert!(older.start < page.start);
    assert_eq!(
        older.messages.last().unwrap().id,
        format!("{ID}:{}", page.start - 1)
    );
}
