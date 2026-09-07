//! Git 变更文件系统监听桥接（fs-watcher 替代定时轮询）。
//!
//! 监听当前活动项目目录，去抖后向前端发 `git-changed` 事件。仅维持单个 watcher
//! （绑定当前活动项目），切项目/关闭面板时释放。watcher 初始化失败时返回错误，
//! 由前端降级为慢轮询。仿 `claude_hook::ClaudeHookBridge` 的桥接模式。

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use log::{debug, warn};
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 前端订阅的事件名；payload 带 projectPath，前端按当前项目过滤（多窗口天然隔离）。
const EVENT_NAME: &str = "git-changed";
/// 去抖窗口：合并连续写，避免保存/暂存触发刷新风暴。
const DEBOUNCE_MS: u64 = 400;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitChangedPayload {
    project_path: String,
}

/// 持有存活的 debouncer（drop 即停止监听）与当前监听的项目路径。
struct WatchState {
    project_path: String,
    _debouncer: Debouncer<RecommendedWatcher>,
}

#[derive(Default)]
pub struct GitWatcherBridge {
    state: Mutex<Option<WatchState>>,
}

impl GitWatcherBridge {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(None),
        }
    }

    /// 开始监听指定项目目录。替换上一个 watcher（单 watcher）。
    /// 路径不可信：为空/不存在返回稳定错误；watcher 初始化失败返回错误供前端降级。
    pub fn start(&self, app_handle: AppHandle, project_path: String) -> Result<(), String> {
        let root = Path::new(&project_path);
        if project_path.is_empty() {
            return Err("path_not_found".to_string());
        }
        if crate::wsl::is_wsl_config_dir(&project_path) {
            warn!("[git_watcher] WSL UNC 路径跳过递归 watcher，前端降级慢轮询: {project_path}");
            return Err("wsl_watch_unsupported".to_string());
        }
        if !root.exists() {
            return Err("path_not_found".to_string());
        }

        // 先释放旧 watcher（仅维持当前活动项目）。
        {
            let mut guard = self.state.lock().map_err(|_| "lock_poisoned".to_string())?;
            *guard = None;
        }

        let emit_handle = app_handle.clone();
        let emit_path = project_path.clone();
        let root_for_filter = project_path.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(DEBOUNCE_MS),
            move |res: DebounceEventResult| match res {
                Ok(events) => {
                    if events
                        .iter()
                        .any(|e| is_relevant(&root_for_filter, &e.path))
                    {
                        let payload = GitChangedPayload {
                            project_path: emit_path.clone(),
                        };
                        if let Err(e) = emit_handle.emit(EVENT_NAME, payload) {
                            warn!("[git_watcher] emit 失败: {e}");
                        }
                    }
                }
                Err(errs) => warn!("[git_watcher] 监听错误: {errs:?}"),
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
            _debouncer: debouncer,
        });
        debug!("[git_watcher] 开始监听: {project_path}");
        Ok(())
    }

    /// 停止监听并释放 watcher。
    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|_| "lock_poisoned".to_string())?;
        if let Some(s) = guard.take() {
            debug!("[git_watcher] 停止监听: {}", s.project_path);
        }
        Ok(())
    }
}

/// 事件路径是否值得触发刷新（噪声过滤，纯函数便于单测）：
/// - 工作区文件变化：相关（排除 `*.lock` 临时锁文件）。
/// - 任意层级的 `.git/index`、`.git/HEAD`：相关（根仓库或嵌套子仓库的暂存/提交/切分支）。
/// - `.git/` 下其它（objects/logs/refs 锁等）：忽略，避免子仓库对象写入触发刷新风暴。
fn is_relevant(root: &str, path: &Path) -> bool {
    let path_str = path.to_string_lossy().replace('\\', "/");
    let root_norm = root.replace('\\', "/");
    let rel = path_str
        .strip_prefix(&root_norm)
        .unwrap_or(&path_str)
        .trim_start_matches('/');

    // 任意层级的 .git 目录本身：忽略。
    if rel == ".git" || rel.ends_with("/.git") {
        return false;
    }

    // 任意层级 .git/ 内部：仅当紧跟的剩余路径恰为 index / HEAD 时相关，
    // 其余（含 index.lock、objects、logs）忽略。
    let git_inner = rel
        .strip_prefix(".git/")
        .or_else(|| rel.find("/.git/").map(|idx| &rel[idx + "/.git/".len()..]));
    if let Some(inner) = git_inner {
        return inner == "index" || inner == "HEAD";
    }

    // 工作区文件：排除锁文件噪声。
    !path_str.ends_with(".lock")
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
    fn nested_git_index_and_head_relevant() {
        assert!(is_relevant(ROOT, Path::new("F:/proj/sub/.git/index")));
        assert!(is_relevant(ROOT, Path::new("F:/proj/sub/.git/HEAD")));
        assert!(is_relevant(
            ROOT,
            Path::new("F:/proj/tools/sub-c/.git/index")
        ));
    }

    #[test]
    fn nested_git_noise_ignored() {
        assert!(!is_relevant(ROOT, Path::new("F:/proj/sub/.git/objects/ab")));
        assert!(!is_relevant(ROOT, Path::new("F:/proj/sub/.git/index.lock")));
        assert!(!is_relevant(ROOT, Path::new("F:/proj/sub/.git/logs/HEAD")));
        assert!(!is_relevant(ROOT, Path::new("F:/proj/sub/.git")));
    }

    #[test]
    fn worktree_lock_ignored() {
        assert!(!is_relevant(ROOT, Path::new("F:/proj/build/cache.lock")));
    }
}
