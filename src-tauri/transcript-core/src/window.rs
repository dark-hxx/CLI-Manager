//! 依位元組視窗讀取 JSONL 紀錄：檔案可能非常大、最後一行可能尚未寫完，因此只讀取範圍內
//! 以換行結尾的完整行，從不整檔載入。Claude Code 與 Codex 的解析器共用這一套讀取。

use crate::event::Event;
use std::{
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

/// 單行上限；超過的行（例如內嵌大型圖片）不解析直接略過。
pub const LINE_LIMIT: usize = 8 * 1024 * 1024;
/// 初始視窗與往前分頁的大小。
pub const WINDOW: u64 = 1536 * 1024;
/// 增量讀取的上限；落後更多時改回傳最新視窗並要求前端重置。
pub const CATCH_UP: u64 = 8 * 1024 * 1024;

/// 讀取範圍：最新視窗、從游標之後增量，或某位置之前的一頁。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Window {
    Tail,
    After(u64),
    Before(u64),
}

/// 一次讀取的大小上限（位元組）：視窗、增量讀取、單行，以及整頁事件序列化後的總量。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub window: u64,
    pub catch_up: u64,
    pub line: usize,
    /// 一頁事件序列化後的總量上限；`usize::MAX` 表示不限制。增量讀取超過時停在那一行之前，
    /// 只把游標推進到那裡；其他視窗從最舊的行開始捨棄。至少保留一行，讀取一定會前進。
    pub output: usize,
    /// 為有 `uuid` 欄位但沒有值的事件補上紀錄行的位置（`pos:<行首位置>:<行內序號>`），
    /// 讓網頁端的 key 在讀進更早內容或重讀時保持不變。
    pub position_keys: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            window: WINDOW,
            catch_up: CATCH_UP,
            line: LINE_LIMIT,
            output: usize::MAX,
            position_keys: false,
        }
    }
}

#[derive(Debug)]
pub struct Page {
    /// 第一個解析行的位元組位置；大於 0 表示前面還有更早的內容。
    pub start: u64,
    /// 最後一個完整行之後的位置，下次增量讀取由此開始。
    pub cursor: u64,
    pub size: u64,
    pub reset: bool,
    pub more: bool,
    /// 增量讀取因 [`Limits::output`] 提早停下，游標之後還有已寫完的行。
    pub partial: bool,
    pub events: Vec<Event>,
}

/// 把原生紀錄的一行整理成事件；Claude Code 與 Codex 各有一個實作，共用同一套視窗讀取。
pub trait LineParser {
    fn parse_line(&mut self, raw: &[u8], out: &mut Vec<Event>);

    /// 同 `parse_line`，另外知道這一行的行首在檔案裡的位置。
    fn parse_line_at(&mut self, _offset: u64, raw: &[u8], out: &mut Vec<Event>) {
        self.parse_line(raw, out);
    }

    /// 讀取視窗前，先以視窗之前最多這麼多位元組的完整行建立解析狀態（不輸出事件），
    /// 讓跨頁的工具呼叫與結果對得上；0 表示不預讀。
    fn prime_bytes(&self) -> u64 {
        0
    }

    /// 預讀結束、開始解析視窗時呼叫；`fresh` 表示前端沒有更早的狀態（初始視窗、重置或往前分頁）。
    fn primed(&mut self, _fresh: bool, _out: &mut Vec<Event>) {}
}

/// 以指定的解析器依視窗讀取任一種 JSONL 紀錄（初始視窗、游標之後、某位置之前）。
/// 游標超過檔案大小（檔案被換過）或落後超過 `catch_up` 時，改回傳最新視窗並標記 `reset`。
pub fn read_with(
    path: &Path,
    window: Window,
    limits: &Limits,
    mut parser: impl LineParser,
) -> io::Result<Page> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let end = last_newline(&mut file, size)?.map_or(0, |position| position + 1);
    let (start, stop, reset) = match window {
        Window::After(from) if from <= size && end.saturating_sub(from) <= limits.catch_up => {
            let from = align_to_line(&mut file, from, end)?;
            (from, end.max(from), false)
        }
        Window::After(_) => (
            window_start(&mut file, size.saturating_sub(limits.window), end)?,
            end,
            true,
        ),
        Window::Tail => (
            window_start(&mut file, size.saturating_sub(limits.window), end)?,
            end,
            false,
        ),
        Window::Before(until) => {
            let stop = until.min(end);
            (
                window_start(&mut file, stop.saturating_sub(limits.window), stop)?,
                stop,
                false,
            )
        }
    };
    let mut events = Vec::new();
    let (mut start, mut cursor, mut partial) = (start, stop, false);
    if stop > start {
        let prime = parser.prime_bytes();
        if prime > 0 && start > 0 {
            let from = window_start(&mut file, start.saturating_sub(prime), start)?;
            file.seek(SeekFrom::Start(from))?;
            let reader = BufReader::with_capacity(64 * 1024, (&mut file).take(start - from));
            let mut ignored = Vec::new();
            for_each_line_from(reader, limits.line, from, |offset, line| {
                parser.parse_line_at(offset, line, &mut ignored);
                ignored.clear();
                true
            })?;
            let fresh = reset || !matches!(window, Window::After(_));
            parser.primed(fresh, &mut events);
        }
        file.seek(SeekFrom::Start(start))?;
        let reader = BufReader::with_capacity(64 * 1024, file.take(stop - start));
        let incremental = matches!(window, Window::After(_)) && !reset;
        // 預讀結束時可能已經放進事件（Codex 的最新狀態），也要算進這一頁的總量。
        let base = if limits.output == usize::MAX {
            0
        } else {
            encoded_len(&events)
        };
        let mut output = Output::new(limits.output, incremental, base);
        for_each_line_from(reader, limits.line, start, |offset, line| {
            let before = events.len();
            parser.parse_line_at(offset, line, &mut events);
            if limits.position_keys {
                for (index, event) in events[before..].iter_mut().enumerate() {
                    event.fill_uuid(|| format!("pos:{offset}:{index}"));
                }
            }
            output.after_line(offset, before, &mut events)
        })?;
        if let Some(cut) = output.cut {
            cursor = cut;
            partial = true;
        }
        if let Some((first, keep_from)) = output.trim() {
            start = first;
            events.drain(..keep_from);
        }
    }
    Ok(Page {
        start,
        cursor,
        size,
        reset,
        more: start > 0,
        partial,
        events,
    })
}

/// 依 [`Limits::output`] 控制一頁事件的總量。
struct Output {
    limit: usize,
    incremental: bool,
    used: usize,
    /// 預讀結束時已經放進這一頁的事件位元組數（在第一行之前）。
    base: usize,
    /// 增量讀取已經收下的行數；至少收一行，讀取才會前進。
    taken: usize,
    /// 增量讀取提早停下的位置：被排除那一行的行首，下次由此繼續。
    cut: Option<u64>,
    /// 其他視窗每一行的（行首位置、事件起始索引、事件位元組數），供超過時從前面捨棄。
    lines: Vec<(u64, usize, usize)>,
}

impl Output {
    fn new(limit: usize, incremental: bool, base: usize) -> Self {
        Self {
            limit,
            incremental,
            used: base,
            base,
            taken: 0,
            cut: None,
            lines: Vec::new(),
        }
    }

    /// 解析完一行後呼叫；傳回 `false` 表示停止讀取。增量讀取時，已有內容又會超過上限的那一行
    /// 不收（事件一併撤回），游標停在它的行首。
    fn after_line(&mut self, offset: u64, before: usize, events: &mut Vec<Event>) -> bool {
        if self.limit == usize::MAX {
            return true;
        }
        let mut bytes = encoded_len(&events[before..]);
        // 單一行就超過整頁的總量（例如一次修補改了很多大檔）：先降級再處理，否則這一行永遠送不出去。
        if bytes > self.limit {
            for event in &mut events[before..] {
                event.shrink();
            }
            bytes = encoded_len(&events[before..]);
        }
        // 降級後仍超過（同一行有很多事件，例如舊版 Claude Code 把整則訊息寫成一行）：只留放得下的
        // 前幾個事件，其餘略過並附上提示，讀取照樣越過這一行。
        if bytes > self.limit {
            keep_within(events, before, self.limit);
            bytes = encoded_len(&events[before..]);
        }
        if !self.incremental {
            self.lines.push((offset, before, bytes));
            return true;
        }
        if self.taken > 0 && self.used + bytes > self.limit {
            events.truncate(before);
            self.cut = Some(offset);
            return false;
        }
        self.used += bytes;
        self.taken += 1;
        true
    }

    /// 視窗的事件（含預讀放進的）超過上限時，從最舊的行開始捨棄：傳回新的起點與要保留的第一個
    /// 事件索引。預讀放進的事件在第一行之前，一有裁切就一併捨棄；最新的一行一定保留。
    fn trim(&self) -> Option<(u64, usize)> {
        let total: usize = self.base + self.lines.iter().map(|line| line.2).sum::<usize>();
        if total <= self.limit {
            return None;
        }
        let mut kept = 0;
        let mut first = None;
        for (index, line) in self.lines.iter().enumerate().rev() {
            if first.is_some() && kept + line.2 > self.limit {
                break;
            }
            kept += line.2;
            first = Some(index);
        }
        first.map(|index| (self.lines[index].0, self.lines[index].1))
    }
}

/// 只保留這一行最前面放得下 `limit` 的事件，略過的部分以一則提示代替；連第一個都放不下時，
/// 整行只剩提示。整頁因此一定在預算內，讀取也照樣越過這一行。
fn keep_within(events: &mut Vec<Event>, before: usize, limit: usize) {
    let notice = Event::Notice {
        at: None,
        code: Some("line_truncated".into()),
        text: "Part of this record was too large to show".into(),
    };
    let budget = limit.saturating_sub(encoded_len(std::slice::from_ref(&notice)) + 2);
    // 陣列的方括號與逗號：每多一個事件多一個逗號。
    let mut used = 2;
    let mut kept = 0;
    for event in &events[before..] {
        let size = encoded_len(std::slice::from_ref(event)) - 2 + usize::from(kept > 0);
        if used + size > budget {
            break;
        }
        used += size;
        kept += 1;
    }
    // 真的略過了事件才附上提示。
    if kept < events.len() - before {
        events.truncate(before + kept);
        events.push(notice);
    }
}

/// 增量讀取的起點應該是行首；不是時（例如請求帶了一行中間的位置）往後對齊到下一個行首，
/// 不把半行當成一筆紀錄解析。落在最後一行（還在寫入）之內時照舊，什麼都不讀。
fn align_to_line(file: &mut File, from: u64, end: u64) -> io::Result<u64> {
    if from == 0 || from >= end {
        return Ok(from);
    }
    let mut previous = [0u8; 1];
    file.seek(SeekFrom::Start(from - 1))?;
    file.read_exact(&mut previous)?;
    if previous[0] == b'\n' {
        return Ok(from);
    }
    Ok(next_newline(file, from, end)?.map_or(end, |position| position + 1))
}

/// 一組事件序列化後的位元組數。
fn encoded_len(events: &[Event]) -> usize {
    if events.is_empty() {
        return 0;
    }
    serde_json::to_vec(events).map_or(0, |bytes| bytes.len())
}

/// 視窗起點：`low` 之後的第一個行首；若視窗內沒有行首（單行比視窗還長），
/// 改從結尾那一行的行首開始，確保往前分頁一定會前進。
fn window_start(file: &mut File, low: u64, stop: u64) -> io::Result<u64> {
    if stop == 0 {
        return Ok(0);
    }
    let start = if low == 0 {
        0
    } else {
        next_newline(file, low - 1, stop)?.map_or(stop, |position| position + 1)
    };
    if start < stop {
        return Ok(start);
    }
    Ok(last_newline(file, stop - 1)?.map_or(0, |position| position + 1))
}

/// `[from, stop)` 中第一個換行的位置。
fn next_newline(file: &mut File, from: u64, stop: u64) -> io::Result<Option<u64>> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut position = from;
    file.seek(SeekFrom::Start(position))?;
    while position < stop {
        let wanted = buffer.len().min((stop - position) as usize);
        let read = file.read(&mut buffer[..wanted])?;
        if read == 0 {
            break;
        }
        if let Some(index) = buffer[..read].iter().position(|&byte| byte == b'\n') {
            return Ok(Some(position + index as u64));
        }
        position += read as u64;
    }
    Ok(None)
}

/// `[0, stop)` 中最後一個換行的位置；從尾端往回分段讀取。
fn last_newline(file: &mut File, stop: u64) -> io::Result<Option<u64>> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut stop = stop;
    while stop > 0 {
        let start = stop.saturating_sub(buffer.len() as u64);
        let length = (stop - start) as usize;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buffer[..length])?;
        if let Some(index) = buffer[..length].iter().rposition(|&byte| byte == b'\n') {
            return Ok(Some(start + index as u64));
        }
        stop = start;
    }
    Ok(None)
}

/// 逐行讀取，只交出以換行結尾的完整行；超過上限的行略過，不會整行留在記憶體。
/// 回呼傳回 `false` 時提早結束。
pub fn for_each_line(
    reader: impl BufRead,
    limit: usize,
    mut each: impl FnMut(&[u8]) -> bool,
) -> io::Result<()> {
    for_each_line_from(reader, limit, 0, |_, line| each(line)).map(|_| ())
}

/// 同 `for_each_line`，另外交出每一行行首的位置（`start` 是讀取起點在檔案裡的位置）；
/// 傳回最後一個完整行之後的位置。
pub fn for_each_line_from(
    mut reader: impl BufRead,
    limit: usize,
    start: u64,
    mut each: impl FnMut(u64, &[u8]) -> bool,
) -> io::Result<u64> {
    let mut line = Vec::new();
    let mut oversized = false;
    let mut position = start;
    let mut line_start = start;
    loop {
        let (consumed, complete) = {
            let buffer = reader.fill_buf()?;
            if buffer.is_empty() {
                return Ok(line_start);
            }
            match buffer.iter().position(|&byte| byte == b'\n') {
                Some(index) => {
                    if !oversized && line.len() + index <= limit {
                        line.extend_from_slice(&buffer[..index]);
                    } else {
                        oversized = true;
                    }
                    (index + 1, true)
                }
                None => {
                    if !oversized && line.len() + buffer.len() <= limit {
                        line.extend_from_slice(buffer);
                    } else {
                        oversized = true;
                        line.clear();
                    }
                    (buffer.len(), false)
                }
            }
        };
        reader.consume(consumed);
        position += consumed as u64;
        if complete {
            let next = oversized || line.is_empty() || each(line_start, &line);
            line.clear();
            oversized = false;
            line_start = position;
            if !next {
                return Ok(line_start);
            }
        }
    }
}
