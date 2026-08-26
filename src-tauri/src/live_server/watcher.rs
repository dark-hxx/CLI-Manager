use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

const DEBOUNCE_MS: u64 = 250;
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

pub struct LiveReloadWatcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl LiveReloadWatcher {
    pub fn start(root: &Path, version: Arc<AtomicU64>) -> Result<Self, String> {
        let watched_root = root.to_path_buf();
        let mut debouncer = new_debouncer(
            Duration::from_millis(DEBOUNCE_MS),
            move |result: DebounceEventResult| handle_events(result, &watched_root, &version),
        )
        .map_err(|error| format!("watcher_init_failed: {error}"))?;
        debouncer
            .watcher()
            .watch(root, RecursiveMode::Recursive)
            .map_err(|error| format!("watch_failed: {error}"))?;
        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

fn handle_events(result: DebounceEventResult, root: &Path, version: &AtomicU64) {
    match result {
        Ok(events) if events.iter().any(|event| is_relevant(root, &event.path)) => {
            version.fetch_add(1, Ordering::Relaxed);
        }
        Ok(_) => {}
        Err(errors) => log::warn!("[live_server] watcher error: {errors:?}"),
    }
}

fn is_relevant(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    !relative.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|segment| IGNORED_SEGMENTS.contains(&segment))
            .unwrap_or(true)
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::is_relevant;

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
}
