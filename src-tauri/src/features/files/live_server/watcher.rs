use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

const DEBOUNCE_MS: u64 = 250;
const SHUTDOWN_POLL_MS: u64 = 50;
const IGNORED_SEGMENTS: &[&str] = &[
    ".git",
    ".gitnexus",
    ".next",
    ".trellis",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
];

type EventResult = Result<Event, notify::Error>;

pub struct LiveReloadWatcher {
    shutdown_tx: Option<mpsc::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

impl LiveReloadWatcher {
    pub fn start(root: &Path, version: Arc<AtomicU64>) -> Result<Self, String> {
        let watched_root = root.to_path_buf();
        let (event_tx, event_rx) = mpsc::channel::<EventResult>();
        let mut watcher = notify::recommended_watcher(move |result| {
            let _ = event_tx.send(result);
        })
        .map_err(|error| format!("watcher_init_failed: {error}"))?;

        let mut watched_dirs = HashSet::new();
        watch_directory_tree(
            &mut watcher,
            &watched_root,
            &watched_root,
            &mut watched_dirs,
        )?;
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let worker_root = watched_root.clone();
        let worker = thread::Builder::new()
            .name("cli-manager-live-reload".to_string())
            .spawn(move || {
                run_event_loop(
                    watcher,
                    event_rx,
                    shutdown_rx,
                    worker_root,
                    version,
                    watched_dirs,
                )
            })
            .map_err(|error| format!("watcher_thread_failed: {error}"))?;

        Ok(Self {
            shutdown_tx: Some(shutdown_tx),
            worker: Some(worker),
        })
    }
}

impl Drop for LiveReloadWatcher {
    fn drop(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                log::warn!("[live_server] watcher thread panicked during shutdown");
            }
        }
    }
}

fn watch_directory_tree(
    watcher: &mut RecommendedWatcher,
    root: &Path,
    start: &Path,
    watched: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let mut pending = vec![start.to_path_buf()];

    while let Some(directory) = pending.pop() {
        if !is_watchable_directory(root, &directory) {
            continue;
        }

        if !watched.contains(&directory) {
            if let Err(error) = watcher.watch(&directory, RecursiveMode::NonRecursive) {
                if directory == start {
                    return Err(format!("watch_failed: {error}"));
                }
                log::warn!("[live_server] failed to watch {directory:?}: {error}");
                continue;
            }
            watched.insert(directory.clone());
        }

        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if directory == start => {
                return Err(format!(
                    "watch_failed: cannot enumerate {directory:?}: {error}"
                ));
            }
            Err(error) => {
                log::debug!("[live_server] failed to enumerate {directory:?}: {error}");
                continue;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if is_watchable_directory(root, &path) {
                pending.push(path);
            }
        }
    }

    Ok(())
}

fn run_event_loop(
    mut watcher: RecommendedWatcher,
    event_rx: mpsc::Receiver<EventResult>,
    shutdown_rx: mpsc::Receiver<()>,
    root: PathBuf,
    version: Arc<AtomicU64>,
    mut watched_dirs: HashSet<PathBuf>,
) {
    loop {
        let Some(first) = receive_event(&event_rx, &shutdown_rx) else {
            return;
        };

        let mut relevant = false;
        process_event(first, &root, &mut watcher, &mut watched_dirs, &mut relevant);

        let mut deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
        loop {
            if shutdown_rx.try_recv().is_ok() {
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match event_rx.recv_timeout(remaining.min(Duration::from_millis(SHUTDOWN_POLL_MS))) {
                Ok(result) => {
                    process_event(
                        result,
                        &root,
                        &mut watcher,
                        &mut watched_dirs,
                        &mut relevant,
                    );
                    // Coalesce bursts, but wait for a quiet period before
                    // publishing the next reload version.
                    deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }

        if relevant {
            version.fetch_add(1, Ordering::SeqCst);
        }
    }
}

fn receive_event(
    event_rx: &mpsc::Receiver<EventResult>,
    shutdown_rx: &mpsc::Receiver<()>,
) -> Option<EventResult> {
    loop {
        if shutdown_rx.try_recv().is_ok() {
            return None;
        }
        match event_rx.recv_timeout(Duration::from_millis(SHUTDOWN_POLL_MS)) {
            Ok(result) => return Some(result),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}

fn process_event(
    result: EventResult,
    root: &Path,
    watcher: &mut RecommendedWatcher,
    watched_dirs: &mut HashSet<PathBuf>,
    relevant: &mut bool,
) {
    let event = match result {
        Ok(event) => event,
        Err(error) => {
            log::warn!("[live_server] watcher error: {error}");
            return;
        }
    };

    for path in event.paths {
        if !is_relevant(root, &path) {
            continue;
        }
        *relevant = true;

        if is_watchable_directory(root, &path) {
            if let Err(error) = watch_directory_tree(watcher, root, &path, watched_dirs) {
                log::debug!("[live_server] failed to register new directory {path:?}: {error}");
            }
        } else if !path.exists() {
            watched_dirs.retain(|directory| directory != &path && !directory.starts_with(&path));
        }
    }
}

fn is_watchable_directory(root: &Path, path: &Path) -> bool {
    if !is_relevant(root, path) || !is_plain_directory(path) {
        return false;
    }
    path.canonicalize()
        .map(|canonical| canonical.starts_with(root))
        .unwrap_or(false)
}

fn is_plain_directory(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    metadata.is_dir()
}

fn is_relevant(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    !relative.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(is_ignored_segment)
            .unwrap_or(true)
    })
}

fn is_ignored_segment(segment: &str) -> bool {
    IGNORED_SEGMENTS.iter().any(|ignored| {
        #[cfg(windows)]
        {
            segment.eq_ignore_ascii_case(ignored)
        }
        #[cfg(not(windows))]
        {
            segment == *ignored
        }
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use tempfile::tempdir;

    use super::{is_relevant, is_watchable_directory};

    #[test]
    fn filters_generated_and_outside_paths() {
        let root = Path::new("C:/project");
        assert!(is_relevant(root, Path::new("C:/project/src/app.js")));
        assert!(!is_relevant(
            root,
            Path::new("C:/project/node_modules/pkg/app.js")
        ));
        assert!(!is_relevant(root, Path::new("C:/other/app.js")));
    }

    #[cfg(windows)]
    #[test]
    fn ignored_directory_names_are_case_insensitive_on_windows() {
        let root = Path::new(r"C:\project");
        assert!(!is_relevant(
            root,
            Path::new(r"C:\project\Node_Modules\pkg\app.js")
        ));
    }

    #[test]
    fn registration_skips_ignored_directories() {
        let temp = tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        assert!(is_watchable_directory(&root, &root.join("src")));
        assert!(!is_watchable_directory(&root, &root.join("node_modules")));
    }

    #[cfg(unix)]
    #[test]
    fn registration_skips_symlinked_directories() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        assert!(!is_watchable_directory(&root, &root.join("linked")));
    }
}
