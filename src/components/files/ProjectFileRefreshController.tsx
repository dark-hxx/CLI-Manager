import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { debugConsoleWarn } from "../../lib/debugConsole";
import { useFileExplorerStore } from "../../stores/fileExplorerStore";

const FILE_WATCH_REFRESH_DEBOUNCE_MS = 600;
const PROJECT_FILE_REFRESH_INTERVAL_MS = 15_000;

/**
 * Keeps project-file refresh alive while the file sidebar is hidden but an
 * editor workspace remains open. It owns watcher/polling lifecycle only;
 * the store remains the single-flight source of file and tree updates.
 */
export function ProjectFileRefreshController() {
  const project = useFileExplorerStore((state) => state.project);
  const remoteFileContext = useFileExplorerStore((state) => state.remoteFileContext);
  const hasOpenFiles = useFileExplorerStore((state) => state.openFiles.length > 0);
  const refreshVisibleState = useFileExplorerStore((state) => state.refreshVisibleState);

  useEffect(() => {
    if (!project) return;

    const projectPath = project.path;
    const remoteProject = project.environment_type === "ssh";
    if ((!remoteProject && !projectPath) || (remoteProject && (!remoteFileContext || !hasOpenFiles))) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    let pollTimer: number | undefined;
    let refreshTimer: number | undefined;
    let pendingChangedPaths: Set<string> | null | undefined;

    const isActive = () => document.visibilityState === "visible" && document.hasFocus();
    const refreshIfActive = (changedPaths?: string[]) => {
      if (isActive()) void refreshVisibleState(changedPaths, { silent: true });
    };
    const scheduleRefreshIfActive = (changedPaths?: string[]) => {
      if (!isActive()) return;
      if (!changedPaths?.length) {
        pendingChangedPaths = null;
      } else if (pendingChangedPaths !== null) {
        pendingChangedPaths ??= new Set<string>();
        for (const path of changedPaths) pendingChangedPaths.add(path);
      }
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const paths = pendingChangedPaths === null
          ? undefined
          : pendingChangedPaths
            ? Array.from(pendingChangedPaths)
            : undefined;
        pendingChangedPaths = undefined;
        refreshIfActive(paths);
      }, FILE_WATCH_REFRESH_DEBOUNCE_MS);
    };
    const startPolling = () => {
      if (pollTimer === undefined) {
        pollTimer = window.setInterval(refreshIfActive, PROJECT_FILE_REFRESH_INTERVAL_MS);
      }
    };
    const stopPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    if (remoteProject) {
      startPolling();
    } else {
      void listen<{ projectPath: string; changedPaths?: string[] }>("project-files-changed", (event) => {
        if (disposed || event.payload.projectPath !== projectPath) return;
        scheduleRefreshIfActive(event.payload.changedPaths);
      }).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

      void invoke("file_watch_start", { projectPath }).catch((err) => {
        debugConsoleWarn("[ProjectFileRefreshController] file_watch_start failed, falling back to polling:", err);
        if (!disposed) startPolling();
      });
    }

    const onFocus = () => refreshIfActive();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshIfActive();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      stopPolling();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (unlisten) unlisten();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (!remoteProject) {
        void invoke("file_watch_stop", { projectPath }).catch(() => {});
      }
    };
  }, [hasOpenFiles, project?.environment_type, project?.id, project?.path, refreshVisibleState, remoteFileContext?.consumerId]);

  return null;
}
