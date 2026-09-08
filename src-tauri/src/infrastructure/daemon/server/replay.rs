use super::super::protocol::{ReplayEntry, MAX_FRAME_BYTES};
use super::{SESSION_BUFFER_MAX_BYTES, SESSION_SPOOL_MAX_BYTES};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;

#[derive(Clone)]
pub(super) struct ReplayFrame {
    pub(super) cols: u16,
    pub(super) rows: u16,
    pub(super) sequence: u64,
    pub(super) data: Vec<u8>,
}

/// 按整帧存储的回放缓冲：每帧都是 PTY reader 切好的 ANSI 安全块，
/// 超限时从头丢弃整帧，天然保持边界安全（契约）。
pub(super) struct SessionBuffer {
    pub(super) frames: VecDeque<ReplayFrame>,
    pub(super) total_bytes: usize,
    pub(super) spool_path: Option<PathBuf>,
    pub(super) spool_bytes: usize,
    pub(super) checkpoint: Option<ReplayFrame>,
    pub(super) truncated: bool,
}

impl SessionBuffer {
    #[cfg(test)]
    // 为测试创建无磁盘路径的缓冲；超出内存阈值时无法溢写，会保留原帧。
    pub(super) fn new() -> Self {
        Self::with_spool(None)
    }

    // 初始化空内存缓冲及可选 spool 路径；不创建文件，也不恢复已有文件的字节计数。
    pub(super) fn with_spool(spool_path: Option<PathBuf>) -> Self {
        Self {
            frames: VecDeque::new(),
            total_bytes: 0,
            spool_path,
            spool_bytes: 0,
            checkpoint: None,
            truncated: false,
        }
    }

    // 复制整帧入内存，超阈值时把最早帧移入 spool 并治理磁盘上限；追加失败则放回内存停止溢写。
    // 此处不重新校验 ANSI 边界或序号顺序，依赖上游提供完整有序帧。
    pub(super) fn push_output(&mut self, cols: u16, rows: u16, sequence: u64, data: &[u8]) {
        self.total_bytes += data.len();
        self.frames.push_back(ReplayFrame {
            cols,
            rows,
            sequence,
            data: data.to_vec(),
        });
        while self.total_bytes > SESSION_BUFFER_MAX_BYTES {
            let Some(front) = self.frames.pop_front() else {
                break;
            };
            if let Err(err) = self.append_spooled_frame(&front) {
                log::warn!("daemon session spool write failed, retaining frame in memory: {err}");
                self.frames.push_front(front);
                break;
            }
            self.total_bytes = self.total_bytes.saturating_sub(front.data.len());
            self.enforce_spool_cap();
        }
    }

    // 用空负载记录尺寸事件；尾帧已为空时直接更新尺寸与序号，合并连续 resize。
    pub(super) fn push_resize(&mut self, cols: u16, rows: u16, sequence: u64) {
        if let Some(last) = self.frames.back_mut() {
            if last.data.is_empty() {
                last.cols = cols;
                last.rows = rows;
                last.sequence = sequence;
                return;
            }
        }
        self.frames.push_back(ReplayFrame {
            cols,
            rows,
            sequence,
            data: Vec::new(),
        });
    }

    // 将完整回放视图逐帧转为协议条目，负载编码为 base64，保留尺寸与序号。
    pub(super) fn replay_entries(&self) -> Vec<ReplayEntry> {
        self.replay_frames()
            .into_iter()
            .map(|frame| ReplayEntry {
                cols: frame.cols,
                rows: frame.rows,
                sequence: frame.sequence,
                data_base64: STANDARD.encode(frame.data),
            })
            .collect()
    }

    // 先放检查点快照，再拼接磁盘与内存中的原始事件；返回拥有独立负载的回放集合。
    pub(super) fn replay_frames(&self) -> Vec<ReplayFrame> {
        self.checkpoint
            .iter()
            .cloned()
            .chain(self.live_frames())
            .collect()
    }

    /// 返回可按 sequence 继续投递的原始事件；checkpoint 是 xterm 快照，
    /// 只能通过 replay/reset 边界消费，不能拼接到现有 live terminal。
    // 按磁盘记录在前、内存帧在后的顺序收集原始事件，不包含检查点也不重新排序。
    pub(super) fn live_frames(&self) -> Vec<ReplayFrame> {
        self.read_spooled_frames()
            .into_iter()
            .chain(self.frames.iter().cloned())
            .collect()
    }

    // 从给定帧快照中借用游标之后的非空输出，排除仅改变尺寸的空事件。
    pub(super) fn output_frames_after<'a>(
        frames: &'a [ReplayFrame],
        after_sequence: u64,
    ) -> Vec<&'a ReplayFrame> {
        frames
            .iter()
            .filter(|frame| frame.sequence > after_sequence && !frame.data.is_empty())
            .collect()
    }

    // 先生成回放条目再按严格大于游标过滤；未给游标按零处理，仍保留符合条件的空尺寸帧。
    pub(super) fn replay_entries_after(&self, after_sequence: Option<u64>) -> Vec<ReplayEntry> {
        let after_sequence = after_sequence.unwrap_or(0);
        self.replay_entries()
            .into_iter()
            .filter(|entry| entry.sequence > after_sequence)
            .collect()
    }

    // 优先返回检查点序号，否则读取 spool 首帧，再退回内存首帧；不是跨来源求最小值。
    pub(super) fn oldest_sequence(&self) -> Option<u64> {
        self.checkpoint
            .as_ref()
            .map(|frame| frame.sequence)
            .or_else(|| {
                self.read_spooled_frames()
                    .first()
                    .map(|frame| frame.sequence)
            })
            .or_else(|| self.frames.front().map(|frame| frame.sequence))
    }

    // 忽略不比现有检查点新的快照；接纳后移除已覆盖的内存事件，并重写仍在游标之后的 spool。
    // 磁盘重写报错时检查点与内存已更新，不回滚；快照合法性和序号范围由调用方检查。
    pub(super) fn accept_checkpoint(
        &mut self,
        cols: u16,
        rows: u16,
        sequence: u64,
        data: Vec<u8>,
    ) -> Result<(), String> {
        if self
            .checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.sequence >= sequence)
        {
            return Ok(());
        }
        self.checkpoint = Some(ReplayFrame {
            cols,
            rows,
            sequence,
            data,
        });
        while self
            .frames
            .front()
            .is_some_and(|frame| frame.sequence <= sequence)
        {
            if let Some(frame) = self.frames.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(frame.data.len());
            }
        }
        let retained: Vec<ReplayFrame> = self
            .read_spooled_frames()
            .into_iter()
            .filter(|frame| frame.sequence > sequence)
            .collect();
        self.write_spooled_frames(&retained)
    }

    // 根据检查点、缓存的 spool 字节数或内存帧判断可回放性，不探测磁盘是否仍可读。
    pub(super) fn replay_available(&self) -> bool {
        self.checkpoint.is_some() || self.spool_bytes > 0 || !self.frames.is_empty()
    }

    // 创建父目录并追加大端 16 字节头和负载；失败可能留下部分记录，不刷新 spool 字节计数。
    pub(super) fn append_spooled_frame(&self, frame: &ReplayFrame) -> Result<(), String> {
        let Some(path) = self.spool_path.as_ref() else {
            return Err("spool path unavailable".to_string());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| err.to_string())?;
        file.write_all(&frame.cols.to_be_bytes())
            .and_then(|_| file.write_all(&frame.rows.to_be_bytes()))
            .and_then(|_| file.write_all(&frame.sequence.to_be_bytes()))
            .and_then(|_| file.write_all(&(frame.data.len() as u32).to_be_bytes()))
            .and_then(|_| file.write_all(&frame.data))
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    // 非空集合先写临时文件、flush，再删除旧文件并重命名；这不是原子替换，也未执行 fsync。
    // 空集合尽力删除 spool 后清零计数；没有路径时同样清零并直接成功。
    pub(super) fn write_spooled_frames(&mut self, frames: &[ReplayFrame]) -> Result<(), String> {
        let Some(path) = self.spool_path.as_ref() else {
            self.spool_bytes = 0;
            return Ok(());
        };
        if frames.is_empty() {
            let _ = std::fs::remove_file(path);
            self.spool_bytes = 0;
            return Ok(());
        }
        let temp_path = path.with_extension("tmp");
        let mut file = File::create(&temp_path).map_err(|err| err.to_string())?;
        let mut bytes = 0usize;
        for frame in frames {
            file.write_all(&frame.cols.to_be_bytes())
                .and_then(|_| file.write_all(&frame.rows.to_be_bytes()))
                .and_then(|_| file.write_all(&frame.sequence.to_be_bytes()))
                .and_then(|_| file.write_all(&(frame.data.len() as u32).to_be_bytes()))
                .and_then(|_| file.write_all(&frame.data))
                .map_err(|err| err.to_string())?;
            bytes = bytes.saturating_add(16 + frame.data.len());
        }
        file.flush().map_err(|err| err.to_string())?;
        if path.exists() {
            std::fs::remove_file(path).map_err(|err| err.to_string())?;
        }
        std::fs::rename(&temp_path, path).map_err(|err| err.to_string())?;
        self.spool_bytes = bytes;
        Ok(())
    }

    // 从文件大小刷新计数，超限则按整帧丢弃最老记录并标记截断；压缩失败仅记录警告。
    pub(super) fn enforce_spool_cap(&mut self) {
        let actual = self
            .spool_path
            .as_ref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|meta| meta.len() as usize)
            .unwrap_or(0);
        self.spool_bytes = actual;
        if actual <= SESSION_SPOOL_MAX_BYTES {
            return;
        }
        let mut frames = self.read_spooled_frames();
        let mut bytes = frames
            .iter()
            .map(|frame| 16 + frame.data.len())
            .sum::<usize>();
        while bytes > SESSION_SPOOL_MAX_BYTES && !frames.is_empty() {
            let removed = frames.remove(0);
            bytes = bytes.saturating_sub(16 + removed.data.len());
            self.truncated = true;
        }
        if let Err(err) = self.write_spooled_frames(&frames) {
            log::warn!("daemon session spool compaction failed: {err}");
        }
    }

    // 顺序读取有界负载记录；路径不可用返回空，头部 EOF 或坏记录终止读取并保留已读前缀。
    pub(super) fn read_spooled_frames(&self) -> Vec<ReplayFrame> {
        let Some(path) = self.spool_path.as_ref() else {
            return Vec::new();
        };
        let Ok(mut file) = File::open(path) else {
            return Vec::new();
        };
        let mut frames = Vec::new();
        loop {
            let mut header = [0u8; 16];
            match file.read_exact(&mut header) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(err) => {
                    log::warn!("daemon session spool read failed: {err}");
                    break;
                }
            }
            let cols = u16::from_be_bytes([header[0], header[1]]);
            let rows = u16::from_be_bytes([header[2], header[3]]);
            let sequence = u64::from_be_bytes(header[4..12].try_into().unwrap());
            let data_len = u32::from_be_bytes(header[12..16].try_into().unwrap()) as usize;
            if data_len > MAX_FRAME_BYTES {
                log::warn!("daemon session spool frame exceeds protocol limit: {data_len}");
                break;
            }
            let mut data = vec![0u8; data_len];
            if let Err(err) = file.read_exact(&mut data) {
                log::warn!("daemon session spool payload read failed: {err}");
                break;
            }
            frames.push(ReplayFrame {
                cols,
                rows,
                sequence,
                data,
            });
        }
        frames
    }
}

impl Drop for SessionBuffer {
    // 缓冲销毁时尽力删除其 spool 文件，清理失败不会在析构中传播。
    fn drop(&mut self) {
        if let Some(path) = self.spool_path.as_ref() {
            let _ = std::fs::remove_file(path);
        }
    }
}
