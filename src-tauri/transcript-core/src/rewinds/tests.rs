use super::*;
use crate::test_support::TempDir;
use serde_json::json;
use std::{fs, time::Duration};

fn prompt(uuid: &str, parent: Option<&str>, text: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"user","uuid":uuid,"parentUuid":parent,"message":{"role":"user","content":text}})
    )
}

fn reply(uuid: &str, parent: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"assistant","uuid":uuid,"parentUuid":parent,"message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}})
    )
}

fn result(uuid: &str, parent: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"user","uuid":uuid,"parentUuid":parent,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}})
    )
}

/// 寫入各行，傳回每一行的行首位置。
fn write(path: &Path, lines: &[String]) -> Vec<u64> {
    let mut offsets = Vec::new();
    let mut total = 0;
    for line in lines {
        offsets.push(total);
        total += line.len() as u64;
    }
    fs::write(path, lines.concat()).unwrap();
    offsets
}

#[test]
fn a_second_prompt_under_the_same_parent_abandons_the_first_branch() {
    let directory = TempDir::new("rewinds-a");
    let path = directory.path().join("a.jsonl");
    let mut lines = vec![
        prompt("a", None, "first"),
        reply("b", "a"),
        prompt("c", Some("b"), "second"),
        reply("d", "c"),
    ];
    let offsets = write(&path, &lines);
    assert!(abandoned(&path).unwrap().is_empty());

    // 回退到「second」之前再問：新提問接在 b 底下。只掃新增的部分也找得到。
    lines.push(prompt("e", Some("b"), "again"));
    lines.push(reply("f", "e"));
    let offsets_after = write(&path, &lines);
    assert_eq!(&offsets_after[..4], &offsets[..]);
    assert_eq!(abandoned(&path).unwrap(), [(offsets[2], offsets_after[4])]);

    // 再回退到 e 之前：範圍往前延伸並合併；沒有父訊息的提問不算回退。
    lines.push(prompt("g", Some("b"), "third try"));
    lines.push(prompt("h", None, "synthetic"));
    let offsets = write(&path, &lines);
    assert_eq!(abandoned(&path).unwrap(), [(offsets[2], offsets[6])]);
}

#[test]
fn parallel_tool_results_and_meta_lines_are_not_rewinds() {
    let directory = TempDir::new("rewinds-b");
    let path = directory.path().join("b.jsonl");
    let lines = vec![
        prompt("a", None, "run both"),
        reply("b1", "a"),
        reply("b2", "b1"),
        // 平行工具呼叫：兩個結果各自接在自己的呼叫底下，也可能接在同一個訊息底下。
        result("r1", "b2"),
        result("r2", "b2"),
        format!(
            "{}\n",
            json!({"type":"user","uuid":"m","parentUuid":"r2","isMeta":true,"message":{"content":"caveat"}})
        ),
        format!(
            "{}\n",
            json!({"type":"user","uuid":"s","parentUuid":"r2","isCompactSummary":true,"message":{"content":"summary"}})
        ),
        prompt("p", Some("r2"), "next"),
    ];
    write(&path, &lines);
    assert!(abandoned(&path).unwrap().is_empty());
}

#[test]
fn a_replaced_file_is_scanned_from_the_start() {
    let directory = TempDir::new("rewinds-c");
    let path = directory.path().join("c.jsonl");
    let lines = vec![
        prompt("a", None, "one"),
        reply("b", "a"),
        prompt("c", Some("b"), "two"),
        prompt("d", Some("b"), "three"),
    ];
    let offsets = write(&path, &lines);
    assert_eq!(abandoned(&path).unwrap(), [(offsets[2], offsets[3])]);
    // 換成另一個（較短的）檔案：舊的掃描結果作廢。
    fs::remove_file(&path).unwrap();
    write(&path, &lines[..2]);
    assert!(abandoned(&path).unwrap().is_empty());
}

#[test]
fn a_different_creation_time_or_a_shorter_file_invalidates_the_scan() {
    // 檔案身分以路徑加建立時間判斷（不依賴 Unix 的 inode）：建立時間不同就是另一個檔案，
    // 長度比掃過的部分還短就是被改寫過；兩者都要從頭重掃。取不到建立時間時只看長度。
    let born = SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_048_526);
    let scan = Scan {
        created: Some(born),
        end: 100,
        ..Scan::default()
    };
    assert!(!scan.outdated(Some(born), 100));
    assert!(!scan.outdated(Some(born), 250));
    assert!(scan.outdated(Some(born), 99));
    assert!(scan.outdated(Some(born + Duration::from_millis(1)), 250));
    assert!(scan.outdated(None, 250));
    let unknown = Scan {
        created: None,
        end: 100,
        ..Scan::default()
    };
    assert!(!unknown.outdated(None, 100));
    assert!(unknown.outdated(None, 10));
}

#[test]
fn has_prompt_ignores_meta_and_tool_lines() {
    let directory = TempDir::new("rewinds-d");
    let path = directory.path().join("d.jsonl");
    write(
        &path,
        &[
            format!(
                "{}\n",
                json!({"type":"permission-mode","permissionMode":"default"})
            ),
            format!(
                "{}\n",
                json!({"type":"user","uuid":"m","isMeta":true,"message":{"content":"caveat"}})
            ),
            result("r", "x"),
        ],
    );
    assert!(!has_prompt(&path).unwrap());
    let mut lines = vec![prompt("a", None, "hello")];
    lines.push(reply("b", "a"));
    write(&path, &lines);
    assert!(has_prompt(&path).unwrap());
}

#[test]
fn ranges_merge_when_they_overlap() {
    let mut ranges = vec![(10, 20), (40, 50)];
    add(&mut ranges, 60, 70);
    add(&mut ranges, 15, 45);
    assert_eq!(ranges, [(10, 50), (60, 70)]);
    add(&mut ranges, 0, 5);
    assert_eq!(ranges, [(0, 5), (10, 50), (60, 70)]);
}
