//! Claude Code 回退（`/rewind`）留下的分叉。
//!
//! 回退對話之後，下一則提問接在被回退那則提問的父訊息底下，被丟掉的那段仍留在紀錄檔裡；
//! CLI 只顯示最新的那一支（從最後一則訊息沿 `parentUuid` 往回走）。紀錄檔只會往後寫，
//! 所以同一個父訊息底下出現第二則提問時，從第一則提問到這一則之前的內容都是丟掉的分支。
//! 只看真正的提問（不看工具結果、meta、壓縮摘要），平行工具呼叫造成的分叉不會被誤判。
//! 沒有父訊息的提問不算：測試與合成的紀錄常常每一行都沒有父訊息，回退到第一則提問之前
//! 也比較少見（多半直接開新會話）。
//!
//! 每個檔案從頭掃一次，之後只掃新增的部分；結果依路徑快取。檔案的身分是路徑加建立時間
//! （各平台都取得到；取不到時只靠長度判斷），建立時間不同或檔案變短時從頭重掃。

use crate::window::{for_each_line_from, LINE_LIMIT};
use memchr::memmem;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
    time::SystemTime,
};

#[cfg(test)]
mod tests;

/// 快取最多保留這麼多個檔案的掃描結果；超過時整批清掉，之後用到的檔案再從頭掃。
const CACHED_FILES: usize = 256;

#[derive(Default)]
struct Scan {
    /// 檔案的建立時間：同一路徑換成另一個檔案時通常會不同，就從頭掃；取不到時為 None。
    created: Option<SystemTime>,
    /// 掃到哪裡（最後一個完整行之後）。
    end: u64,
    /// 父訊息 → 它底下第一則提問的行首。
    first: HashMap<String, u64>,
    /// 丟掉的範圍：[第一則提問的行首, 重問那一行的行首)，依起點排序、互不重疊。
    ranges: Vec<(u64, u64)>,
}

impl Scan {
    /// 快取的結果不再適用：檔案換過（建立時間不同）或被改寫得比掃過的部分還短。
    fn outdated(&self, created: Option<SystemTime>, len: u64) -> bool {
        self.created != created || len < self.end
    }
}

/// 每個檔案一把鎖：第一次掃大檔案時不會擋住其他會話的讀取。
fn scan_of(path: &Path) -> Arc<Mutex<Scan>> {
    static SCANS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Scan>>>>> = OnceLock::new();
    let mut scans = lock(SCANS.get_or_init(Default::default));
    if scans.len() >= CACHED_FILES && !scans.contains_key(path) {
        // 清掉的項目若正被其他執行緒使用，它們手上的那份照常完成，只是不再留在快取裡。
        scans.clear();
    }
    scans.entry(path.to_path_buf()).or_default().clone()
}

/// 取得鎖；先前持有鎖的執行緒 panic 過時照樣取用（內容由呼叫端自行判斷是否可信）。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 紀錄檔裡被回退丟掉的範圍（位元組，左閉右開），依起點排序、互不重疊。
pub fn abandoned(path: &Path) -> io::Result<Vec<(u64, u64)>> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    let created = metadata.created().ok();
    let shared = scan_of(path);
    let mut scan = match shared.lock() {
        Ok(scan) => scan,
        // 上次掃描到一半就 panic：結果可能不完整，清掉中毒標記並從頭重掃。
        Err(poisoned) => {
            shared.clear_poison();
            let mut scan = poisoned.into_inner();
            *scan = Scan::default();
            scan
        }
    };
    if scan.outdated(created, metadata.len()) {
        *scan = Scan {
            created,
            ..Scan::default()
        };
    }
    if metadata.len() > scan.end {
        let from = scan.end;
        file.seek(SeekFrom::Start(from))?;
        let reader = BufReader::with_capacity(256 * 1024, file.take(metadata.len() - from));
        let Scan { first, ranges, .. } = &mut *scan;
        let end = for_each_line_from(reader, LINE_LIMIT, from, |offset, line| {
            if let Some(parent) = prompt_parent(line) {
                match first.get(&parent) {
                    Some(&start) => add(ranges, start, offset),
                    None => {
                        first.insert(parent, offset);
                    }
                }
            }
            true
        })?;
        scan.end = end;
    }
    Ok(scan.ranges.clone())
}

/// 加入一段範圍並和重疊的合併（再次回退到更早的地方會蓋過之前的範圍）。
fn add(ranges: &mut Vec<(u64, u64)>, start: u64, end: u64) {
    let (mut start, mut end) = (start, end);
    ranges.retain(|&(from, to)| {
        if from <= end && start <= to {
            start = start.min(from);
            end = end.max(to);
            false
        } else {
            true
        }
    });
    let at = ranges.partition_point(|&(from, _)| from < start);
    ranges.insert(at, (start, end));
}

/// 紀錄裡有沒有任何一則真正的提問（新會話是不是一句話都還沒說）；找到第一則就停。
pub fn has_prompt(path: &Path) -> io::Result<bool> {
    let file = File::open(path)?;
    let mut found = false;
    for_each_line_from(BufReader::new(file), LINE_LIMIT, 0, |_, line| {
        found = is_prompt(line);
        !found
    })?;
    Ok(found)
}

/// 真正的提問（不是工具結果、meta、壓縮摘要）。
fn is_prompt(raw: &[u8]) -> bool {
    if memmem::find(raw, br#""type":"user""#).is_none()
        || memmem::find(raw, br#""tool_use_id""#).is_some()
    {
        return false;
    }
    let Ok(line) = serde_json::from_slice::<Value>(raw) else {
        return false;
    };
    line["type"] == "user"
        && ![
            "isSidechain",
            "isMeta",
            "isCompactSummary",
            "isVisibleInTranscriptOnly",
        ]
        .iter()
        .any(|key| line[*key] == true)
        && match &line["message"]["content"] {
            Value::String(text) => !text.trim().is_empty(),
            Value::Array(blocks) => {
                blocks.iter().all(|block| block["type"] != "tool_result")
                    && blocks
                        .iter()
                        .any(|block| matches!(block["type"].as_str(), Some("text" | "image")))
            }
            _ => false,
        }
}

/// 真正的提問行：傳回它的父訊息。
fn prompt_parent(raw: &[u8]) -> Option<String> {
    // 先用字串篩掉絕大多數的行，剩下的才解析 JSON。
    if memmem::find(raw, br#""type":"user""#).is_none()
        || memmem::find(raw, br#""tool_use_id""#).is_some()
    {
        return None;
    }
    let line: Value = serde_json::from_slice(raw).ok()?;
    if line["type"] != "user"
        || [
            "isSidechain",
            "isMeta",
            "isCompactSummary",
            "isVisibleInTranscriptOnly",
        ]
        .iter()
        .any(|key| line[*key] == true)
    {
        return None;
    }
    line["uuid"].as_str()?;
    let real = match &line["message"]["content"] {
        Value::String(text) => !text.is_empty(),
        Value::Array(blocks) => {
            blocks.iter().all(|block| block["type"] != "tool_result")
                && blocks
                    .iter()
                    .any(|block| matches!(block["type"].as_str(), Some("text" | "image")))
        }
        _ => false,
    };
    let parent = line["parentUuid"]
        .as_str()
        .filter(|parent| !parent.is_empty())?;
    real.then(|| parent.to_string())
}
