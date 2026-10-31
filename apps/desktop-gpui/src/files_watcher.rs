use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::io;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;

struct FileWatcher {
    _watcher: RecommendedWatcher,
    events: UnboundedReceiver<notify::Result<Event>>,
    root: PathBuf,
}

impl FileWatcher {
    fn new(root: PathBuf) -> notify::Result<Self> {
        let root = root.canonicalize().unwrap_or(root);
        let (sender, events) = mpsc::unbounded_channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            events,
            root,
        })
    }

    async fn next_changed(&mut self) -> io::Result<bool> {
        let first = self
            .events
            .recv()
            .await
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "file_watcher_closed"))?;
        let mut changed = false;
        self.collect(first, &mut changed)?;
        while let Ok(event) = self.events.try_recv() {
            self.collect(event, &mut changed)?;
        }
        Ok(changed)
    }

    fn collect(&self, event: notify::Result<Event>, changed: &mut bool) -> io::Result<()> {
        let event = event.map_err(|error| io::Error::other(error.to_string()))?;
        if matches!(event.kind, EventKind::Access(_)) {
            return Ok(());
        }
        for path in event.paths {
            let Ok(relative) = path.strip_prefix(&self.root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            if !relative.is_empty() && relative != ".git" && !relative.starts_with(".git/") {
                *changed = true;
            }
        }
        Ok(())
    }
}

fn is_wsl_path(path: &Path) -> bool {
    let path = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    path.starts_with("//wsl$/") || path.starts_with("//wsl.localhost/")
}

fn is_unc_path(path: &Path) -> bool {
    path.to_string_lossy().replace('\\', "/").starts_with("//")
}

pub async fn run_file_watcher(
    root: PathBuf,
    mut cancel: oneshot::Receiver<()>,
    changed: UnboundedSender<()>,
) {
    let mut watcher = match FileWatcher::new(root) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!("[files] watcher unavailable: {error}");
            run_file_polling(cancel, changed).await;
            return;
        }
    };
    loop {
        tokio::select! {
            _ = &mut cancel => break,
            result = watcher.next_changed() => match result {
                Ok(true) => {
                    if changed.send(()).is_err() {
                        break;
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    eprintln!("[files] watcher stopped: {error}");
                    run_file_polling(cancel, changed).await;
                    break;
                }
            }
        }
    }
}

const FILE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

async fn run_file_polling(cancel: oneshot::Receiver<()>, changed: UnboundedSender<()>) {
    run_file_polling_with_interval(cancel, changed, FILE_POLL_INTERVAL).await;
}

async fn run_file_polling_with_interval(
    mut cancel: oneshot::Receiver<()>,
    changed: UnboundedSender<()>,
    interval: std::time::Duration,
) {
    let mut ticker = tokio::time::interval(interval);
    ticker.tick().await;
    loop {
        tokio::select! {
            _ = &mut cancel => break,
            _ = ticker.tick() => {
                if changed.send(()).is_err() {
                    break;
                }
            }
        }
    }
}

pub fn watcher_supported(root: &Path) -> bool {
    !is_wsl_path(root) && !is_unc_path(root)
}

pub fn start_file_watcher(
    shell: &mut crate::DesktopShell,
    project_id: &str,
    path: &Path,
    generation: u64,
    cx: &mut gpui::Context<crate::DesktopShell>,
) {
    let (cancel, cancellation) = oneshot::channel();
    let (changed_sender, mut changed_receiver) = mpsc::unbounded_channel();
    shell.file_watch_cancel = Some(cancel);
    let watch_task = if watcher_supported(path) {
        shell._runtime.spawn(run_file_watcher(
            path.to_owned(),
            cancellation,
            changed_sender,
        ))
    } else {
        eprintln!(
            "[files] watcher degraded for remote or WSL path; using 15s polling: {}",
            path.display()
        );
        shell
            ._runtime
            .spawn(run_file_polling(cancellation, changed_sender))
    };
    let expected_project = project_id.to_owned();
    cx.spawn(async move |this, cx| {
        while changed_receiver.recv().await.is_some() {
            while changed_receiver.try_recv().is_ok() {}
            let should_refresh = this
                .update(cx, |this, cx| {
                    if this.file_watch_generation != generation
                        || this.selected_project.as_deref() != Some(expected_project.as_str())
                    {
                        return false;
                    }
                    super::refresh_tree(this, cx);
                    true
                })
                .unwrap_or(false);
            if !should_refresh {
                break;
            }
        }
        let _ = watch_task.await;
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn local_watcher_reports_changes_and_stops_on_cancel() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let root = tempdir().unwrap();
            let (cancel_sender, cancel_receiver) = oneshot::channel();
            let (changed_sender, mut changed_receiver) = mpsc::unbounded_channel();
            let task = tokio::spawn(run_file_watcher(
                root.path().to_owned(),
                cancel_receiver,
                changed_sender,
            ));
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            fs::write(root.path().join("created.txt"), "content").unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), changed_receiver.recv())
                .await
                .expect("watcher should report a local file change")
                .expect("watcher channel should remain open until cancellation");
            cancel_sender.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), task)
                .await
                .expect("watcher should stop after cancellation")
                .unwrap();
        });
    }

    #[test]
    fn watcher_skips_wsl_and_unc_paths() {
        assert!(!watcher_supported(Path::new(
            r"\\wsl.localhost\Ubuntu\workspace"
        )));
        assert!(!watcher_supported(Path::new(r"\\server\share\workspace")));
        assert!(watcher_supported(Path::new(r"C:\workspace")));
    }

    #[test]
    fn polling_reports_changes_and_stops_on_cancel() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let (cancel_sender, cancel_receiver) = oneshot::channel();
            let (changed_sender, mut changed_receiver) = mpsc::unbounded_channel();
            let task = tokio::spawn(run_file_polling_with_interval(
                cancel_receiver,
                changed_sender,
                std::time::Duration::from_millis(10),
            ));
            tokio::time::timeout(std::time::Duration::from_secs(1), changed_receiver.recv())
                .await
                .expect("polling should trigger a refresh")
                .expect("polling channel should remain open until cancellation");
            cancel_sender.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .expect("polling should stop after cancellation")
                .unwrap();
        });
    }
}
