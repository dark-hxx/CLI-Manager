use crate::{TailLine, TailState};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc::{self, UnboundedReceiver};

/// 一个共享文件系统 watcher 的单个转录更新。
#[derive(Debug, PartialEq, Eq)]
pub struct TranscriptUpdate {
    pub path: PathBuf,
    pub reset: bool,
    pub lines: Vec<TailLine>,
    pub bytes_read: usize,
}

/// 按目录复用 notify watcher，并为每个文件保存独立的增量读取状态。
///
/// `next_batch` 由上层 tokio 任务驱动，因此监听 20 个文件不会创建 20 个 sleep
/// 线程；首次扫描可以通过 `register_path` 顺序或由调用方按 CPU 配额并发完成。
pub struct TranscriptWatcher {
    _watcher: RecommendedWatcher,
    events: UnboundedReceiver<notify::Result<Event>>,
    files: HashMap<PathBuf, TailState>,
    watched_dirs: HashSet<PathBuf>,
}

impl TranscriptWatcher {
    pub fn new() -> notify::Result<Self> {
        let (sender, events) = mpsc::unbounded_channel();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })?;
        Ok(Self {
            _watcher: watcher,
            events,
            files: HashMap::new(),
            watched_dirs: HashSet::new(),
        })
    }

    /// 注册一个转录文件并立即读取现有完整行，返回 `None` 表示文件暂不存在。
    pub fn register_path(
        &mut self,
        path: impl AsRef<Path>,
    ) -> io::Result<Option<TranscriptUpdate>> {
        let path = normalize_path(path.as_ref());
        self.watch_path(&path)?;
        let mut state = self.files.remove(&path).unwrap_or_default();
        if !path.exists() {
            self.files.insert(path, state);
            return Ok(None);
        }
        let update = state.read_path(&path)?;
        self.files.insert(path.clone(), state);
        Ok(Some(TranscriptUpdate {
            path,
            reset: update.reset,
            lines: update.lines,
            bytes_read: update.bytes_read,
        }))
    }

    /// 仅建立目录监听和文件状态，不触发首轮读取；适合已有 Reader 负责首轮扫描的调用方。
    pub fn watch_path(&mut self, path: impl AsRef<Path>) -> io::Result<()> {
        let path = normalize_path(path.as_ref());
        let Some(parent) = path.parent() else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "transcript_parent_missing",
            ));
        };
        if self.watched_dirs.insert(parent.to_path_buf()) {
            self._watcher
                .watch(parent, RecursiveMode::NonRecursive)
                .map_err(notify_to_io)?;
        }
        self.files.entry(path).or_default();
        Ok(())
    }

    pub fn unregister_path(&mut self, path: impl AsRef<Path>) {
        self.files.remove(&normalize_path(path.as_ref()));
    }

    /// 等待 notify 事件，并把同一批事件涉及的文件合并后增量读取。
    pub async fn next_batch(&mut self) -> io::Result<Vec<TranscriptUpdate>> {
        let paths = self.next_changed_paths().await?;
        self.refresh_paths(paths)
    }

    /// 只等待并合并变化路径，不触发文件读取；适合正文由其他 Reader 消费的订阅方。
    pub async fn next_changed_paths(&mut self) -> io::Result<Vec<PathBuf>> {
        let first = self.events.recv().await.ok_or_else(|| {
            io::Error::new(io::ErrorKind::BrokenPipe, "transcript_watcher_closed")
        })?;
        let mut paths = HashSet::new();
        self.collect_event(first, &mut paths)?;
        while let Ok(event) = self.events.try_recv() {
            self.collect_event(event, &mut paths)?;
        }
        Ok(paths.into_iter().collect())
    }

    /// 供首次扫描、测试和 watcher 事件合并复用的增量刷新入口。
    pub fn refresh_paths(
        &mut self,
        paths: impl IntoIterator<Item = PathBuf>,
    ) -> io::Result<Vec<TranscriptUpdate>> {
        let mut updates = Vec::new();
        for path in paths {
            let path = normalize_path(&path);
            let Some(mut state) = self.files.remove(&path) else {
                continue;
            };
            if !path.exists() {
                self.files.insert(path, state);
                continue;
            }
            let update = state.read_path(&path)?;
            self.files.insert(path.clone(), state);
            if update.reset || !update.lines.is_empty() || update.bytes_read > 0 {
                updates.push(TranscriptUpdate {
                    path,
                    reset: update.reset,
                    lines: update.lines,
                    bytes_read: update.bytes_read,
                });
            }
        }
        Ok(updates)
    }

    fn collect_event(
        &self,
        event: notify::Result<Event>,
        paths: &mut HashSet<PathBuf>,
    ) -> io::Result<()> {
        let event = event.map_err(notify_to_io)?;
        for path in event.paths {
            let path = normalize_path(&path);
            if self.files.contains_key(&path) {
                paths.insert(path);
            }
        }
        Ok(())
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(path) = path.canonicalize() {
        return path;
    }
    path.parent()
        .and_then(|parent| parent.canonicalize().ok())
        .and_then(|parent| path.file_name().map(|name| parent.join(name)))
        .unwrap_or_else(|| path.to_path_buf())
}

fn notify_to_io(error: notify::Error) -> io::Error {
    io::Error::new(io::ErrorKind::Other, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::TranscriptWatcher;
    use std::fs;
    use std::io::Write;
    use std::time::{Duration, Instant};
    use tempfile::tempdir;

    #[test]
    fn shares_one_watcher_for_files_in_the_same_directory() {
        let directory = tempdir().unwrap();
        let first_path = directory.path().join("first.jsonl");
        let second_path = directory.path().join("second.jsonl");
        fs::write(&first_path, b"{\"id\":1}\n").unwrap();
        fs::write(&second_path, b"{\"id\":2}\n").unwrap();
        let mut watcher = TranscriptWatcher::new().unwrap();
        let first = watcher.register_path(&first_path).unwrap().unwrap();
        let second = watcher.register_path(&second_path).unwrap().unwrap();
        assert_eq!(first.lines.len(), 1);
        assert_eq!(second.lines.len(), 1);

        let mut first_file = fs::OpenOptions::new()
            .append(true)
            .open(&first_path)
            .unwrap();
        first_file.write_all(b"{\"id\":3}\n").unwrap();
        let mut second_file = fs::OpenOptions::new()
            .append(true)
            .open(&second_path)
            .unwrap();
        second_file.write_all(b"{\"id\":4}\n").unwrap();
        let updates = watcher
            .refresh_paths([first_path.clone(), second_path.clone()])
            .unwrap();
        assert_eq!(updates.len(), 2);
        assert!(updates.iter().all(|update| update.lines.len() == 1));
    }

    #[test]
    fn missing_file_can_be_registered_before_it_is_created() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("late.jsonl");
        let mut watcher = TranscriptWatcher::new().unwrap();
        assert!(watcher.register_path(&path).unwrap().is_none());
        fs::write(&path, b"late\n").unwrap();
        let updates = watcher.refresh_paths([path]).unwrap();
        assert_eq!(updates[0].lines[0].text, "late");
    }

    #[test]
    fn twenty_files_share_one_directory_and_refresh_within_latency_budget() {
        let directory = tempdir().unwrap();
        let paths = (0..20)
            .map(|index| directory.path().join(format!("session-{index}.jsonl")))
            .collect::<Vec<_>>();
        for path in &paths {
            fs::write(path, b"initial\n").unwrap();
        }
        let mut watcher = TranscriptWatcher::new().unwrap();
        for path in &paths {
            watcher.register_path(path).unwrap();
        }
        assert_eq!(watcher.watched_dirs.len(), 1);
        for path in &paths {
            let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
            writeln!(file, "appended").unwrap();
        }
        let started = Instant::now();
        let updates = watcher.refresh_paths(paths.clone()).unwrap();
        assert_eq!(updates.len(), paths.len());
        assert!(started.elapsed() < Duration::from_millis(300));
        assert!(updates.iter().all(|update| update.lines.len() == 1));
    }
}
