//! 项目文件浏览器文件系统监听桥接。
//!
//! 与 Git watcher 类似，监听当前项目目录变更并在去抖后向前端发送
//! `project-files-changed` 事件。支持同项目多订阅者复用一个 watcher。

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use log::{debug, warn};
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const EVENT_NAME: &str = "project-files-changed";
const DEBOUNCE_MS: u64 = 400;
const IGNORED_DIRS: &[&str] = &[
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFilesChangedPayload {
    project_path: String,
    changed_paths: Vec<String>,
}

struct WatchState {
    project_path: String,
    subscribers: usize,
    _debouncer: Debouncer<RecommendedWatcher>,
}

#[derive(Default)]
pub struct FileWatcherBridge {
    state: Mutex<Option<WatchState>>,
}

impl FileWatcherBridge {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(None),
        }
    }

    pub fn start(&self, app_handle: AppHandle, project_path: String) -> Result<(), String> {
        let root = Path::new(&project_path);
        if project_path.is_empty() {
            return Err("path_not_found".to_string());
        }
        if crate::wsl::is_wsl_config_dir(&project_path) {
            warn!("[file_watcher] WSL UNC 路径跳过递归 watcher，前端降级慢轮询: {project_path}");
            return Err("wsl_watch_unsupported".to_string());
        }
        if !root.exists() {
            return Err("path_not_found".to_string());
        }

        {
            let mut guard = self.state.lock().map_err(|_| "lock_poisoned".to_string())?;
            if let Some(state) = guard.as_mut() {
                if state.project_path == project_path {
                    state.subscribers += 1;
                    debug!(
                        "[file_watcher] 复用监听: {} (subscribers={})",
                        state.project_path, state.subscribers
                    );
                    return Ok(());
                }
            }
            *guard = None;
        }

        let emit_handle = app_handle.clone();
        let emit_path = project_path.clone();
        let root_for_filter = project_path.clone();
        let mut debouncer = new_debouncer(
            Duration::from_millis(DEBOUNCE_MS),
            move |res: DebounceEventResult| match res {
                Ok(events) => {
                    let changed_paths = events
                        .iter()
                        .filter(|e| is_relevant(&root_for_filter, &e.path))
                        .filter_map(|e| project_relative_path(&root_for_filter, &e.path))
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect::<Vec<_>>();

                    if !changed_paths.is_empty() {
                        let payload = ProjectFilesChangedPayload {
                            project_path: emit_path.clone(),
                            changed_paths,
                        };
                        if let Err(e) = emit_handle.emit(EVENT_NAME, payload) {
                            warn!("[file_watcher] emit 失败: {e}");
                        }
                    }
                }
                Err(errs) => warn!("[file_watcher] 监听错误: {errs:?}"),
            },
        )
        .map_err(|e| format!("watcher_init_failed: {e}"))?;

        debouncer
            .watcher()
            .watch(root, RecursiveMode::Recursive)
            .map_err(|e| format!("watch_failed: {e}"))?;

        let mut guard = self.state.lock().map_err(|_| "lock_poisoned".to_string())?;
        *guard = Some(WatchState {
            project_path: project_path.clone(),
            subscribers: 1,
            _debouncer: debouncer,
        });
        debug!("[file_watcher] 开始监听: {project_path}");
        Ok(())
    }

    pub fn stop(&self, project_path: String) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|_| "lock_poisoned".to_string())?;
        let Some(state) = guard.as_mut() else {
            return Ok(());
        };
        if state.project_path != project_path {
            return Ok(());
        }
        if state.subscribers > 1 {
            state.subscribers -= 1;
            debug!(
                "[file_watcher] 保留监听: {} (subscribers={})",
                state.project_path, state.subscribers
            );
            return Ok(());
        }
        debug!("[file_watcher] 停止监听: {}", state.project_path);
        *guard = None;
        Ok(())
    }
}

fn is_relevant(root: &str, path: &Path) -> bool {
    let Some(rel) = project_relative_path(root, path) else {
        return false;
    };

    if rel == ".git" {
        return false;
    }
    if let Some(git_rel) = rel.strip_prefix(".git/") {
        return git_rel == "index" || git_rel == "HEAD";
    }

    if rel
        .split('/')
        .any(|segment| IGNORED_DIRS.contains(&segment))
    {
        return false;
    }

    !rel.ends_with(".lock")
}

fn project_relative_path(root: &str, path: &Path) -> Option<String> {
    let path_str = path.to_string_lossy().replace('\\', "/");
    let root_norm = root.replace('\\', "/").trim_end_matches('/').to_string();
    if path_str == root_norm {
        return Some(String::new());
    }
    path_str
        .strip_prefix(&format!("{root_norm}/"))
        .map(|rel| rel.trim_start_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::is_relevant;
    use std::path::Path;

    const ROOT: &str = "F:/proj";

    #[test]
    fn worktree_file_is_relevant() {
        assert!(is_relevant(ROOT, Path::new("F:/proj/src/main.rs")));
        assert!(is_relevant(ROOT, Path::new("F:\\proj\\src\\main.rs")));
    }

    #[test]
    fn git_index_and_head_relevant() {
        assert!(is_relevant(ROOT, Path::new("F:/proj/.git/index")));
        assert!(is_relevant(ROOT, Path::new("F:/proj/.git/HEAD")));
    }

    #[test]
    fn git_noise_ignored() {
        assert!(!is_relevant(ROOT, Path::new("F:/proj/.git/index.lock")));
        assert!(!is_relevant(ROOT, Path::new("F:/proj/.git/objects/ab/cd")));
        assert!(!is_relevant(ROOT, Path::new("F:/proj/.git/logs/HEAD")));
        assert!(!is_relevant(ROOT, Path::new("F:/proj/.git")));
    }

    #[test]
    fn worktree_lock_ignored() {
        assert!(!is_relevant(ROOT, Path::new("F:/proj/build/cache.lock")));
    }

    #[test]
    fn generated_directories_ignored() {
        assert!(!is_relevant(
            ROOT,
            Path::new("F:/proj/node_modules/pkg/index.js")
        ));
        assert!(!is_relevant(
            ROOT,
            Path::new("F:/proj/target/debug/app.exe")
        ));
        assert!(!is_relevant(ROOT, Path::new("F:/proj/.gitnexus/index.db")));
    }
}
