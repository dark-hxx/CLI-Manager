import { useCallback, useEffect, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { isTauri } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/sidebar";
import { TerminalTabs } from "./components/TerminalTabs";
import { CommandPalette } from "./components/CommandPalette";
import { StatsPanel } from "./components/stats/StatsPanel";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { useSettingsStore } from "./stores/settingsStore";
import { useProjectStore } from "./stores/projectStore";
import { useSessionStore } from "./stores/sessionStore";
import { useTerminalStore } from "./stores/terminalStore";
import { useSyncStore } from "./stores/syncStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useHistoryStore } from "./stores/historyStore";
import { createPerfMarker, logWarn } from "./lib/logger";
import "./App.css";

const appStartAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
let firstScreenPerfReported = false;
const COMPACT_WINDOW_WIDTH = 350;
const WINDOW_MIN_HEIGHT = 600;
const IN_TAURI = isTauri();

function App() {
  const loadSettings = useSettingsStore((s) => s.load);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const historySessions = useHistoryStore((s) => s.sessions);
  const loadHistorySessions = useHistoryStore((s) => s.loadSessions);
  const openHistoryWorkspace = useHistoryStore((s) => s.openHistory);
  const openHistorySession = useHistoryStore((s) => s.openSession);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const [statsOpen, setStatsOpen] = useState(false);
  const restoreWindowWidthRef = useRef<number | null>(null);

  useKeyboardShortcuts();

  useEffect(() => {
    const init = async () => {
      // 1. 加载设置
      await loadSettings();

      // 2. 加载同步配置
      await useSyncStore.getState().load();

      // 3. 加载会话持久化数据
      await useSessionStore.getState().load();

      // 4. 加载项目列表
      await useProjectStore.getState().fetchAll();

      // 5. 恢复终端会话
      const { projects, projectHealth } = useProjectStore.getState();
      const projectMap = new Map(projects.map((p) => [p.id, p]));
      await useTerminalStore.getState().restoreSessions(projectMap, projectHealth);
    };
    init().catch((err) => {
      toast.error("初始化失败", { description: String(err) });
    });
  }, [loadSettings]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    document.documentElement.setAttribute("data-light-palette", lightThemePalette);
    document.documentElement.setAttribute("data-dark-palette", darkThemePalette);
  }, [resolvedTheme, lightThemePalette, darkThemePalette]);

  // 应用关闭时清除会话持久化数据（不恢复主动关闭时的终端）
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlistenPromise: Promise<() => void> | null = null;

    unlistenPromise = appWindow.onCloseRequested(async () => {
      await useSessionStore.getState().clear();
    });

    return () => {
      unlistenPromise?.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    const appWindow = getCurrentWindow();
    void (async () => {
      try {
        if (viewMode !== "compact") {
          if (restoreWindowWidthRef.current && restoreWindowWidthRef.current > COMPACT_WINDOW_WIDTH) {
            await appWindow.setSize(
              new LogicalSize(restoreWindowWidthRef.current, Math.max(window.innerHeight, WINDOW_MIN_HEIGHT))
            );
          }
          await appWindow.setMinSize(new LogicalSize(800, WINDOW_MIN_HEIGHT));
          restoreWindowWidthRef.current = null;
          return;
        }
        if (restoreWindowWidthRef.current == null) {
          restoreWindowWidthRef.current = window.innerWidth;
        }
        await appWindow.setMinSize(new LogicalSize(COMPACT_WINDOW_WIDTH, WINDOW_MIN_HEIGHT));
        if (await appWindow.isMaximized()) {
          await appWindow.unmaximize();
        }
        await appWindow.setSize(
          new LogicalSize(COMPACT_WINDOW_WIDTH, Math.max(window.innerHeight, WINDOW_MIN_HEIGHT))
        );
      } catch (err) {
        logWarn("Failed to shrink window for compact mode", err);
      }
    })();
  }, [viewMode]);

  const handleOpenStats = useCallback(() => {
    const stopPerf = createPerfMarker("stats.open", {
      sessionsBefore: historySessions.length,
    });
    void (async () => {
      try {
        if (historySessions.length === 0) {
          await loadHistorySessions();
        }
        setStatsOpen(true);
        stopPerf({ sessionsAfter: useHistoryStore.getState().sessions.length });
      } catch (err) {
        stopPerf({ error: String(err) });
        toast.error("加载历史会话失败", { description: String(err) });
      }
    })();
  }, [historySessions.length, loadHistorySessions]);

  const handleOpenSessionFromStats = useCallback(
    async (sessionKey: string) => {
      try {
        await openHistoryWorkspace();
        await openHistorySession(sessionKey);
      } catch (err) {
        toast.error("跳转历史会话失败", { description: String(err) });
        throw err;
      }
    },
    [openHistoryWorkspace, openHistorySession]
  );

  useEffect(() => {
    if (firstScreenPerfReported) return;
    let raf1 = 0;
    let raf2 = 0;
    const stopPerf = createPerfMarker("app.first_screen", {
      bootElapsedMs:
        (typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now()) - appStartAt,
    });
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (firstScreenPerfReported) return;
        firstScreenPerfReported = true;
        stopPerf({
          resolvedTheme,
          statsPrefetched: historySessions.length > 0,
          viewMode,
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [resolvedTheme, historySessions.length, viewMode]);

  return (
    <div className="ui-workspace-shell flex h-screen flex-col">
      <a href="#main-content" className="skip-link">
        跳转到主内容
      </a>
      <WindowTitleBar />
      {viewMode === "compact" ? (
        <div id="main-content" className="flex min-h-0 flex-1" tabIndex={-1}>
          <Sidebar onOpenStats={handleOpenStats} compactMode />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar onOpenStats={handleOpenStats} />
          <main id="main-content" className="ui-main-shell flex min-w-0 flex-1 flex-col" tabIndex={-1}>
            <TerminalTabs />
          </main>
        </div>
      )}
      <CommandPalette />
      <StatsPanel
        open={statsOpen}
        sessions={historySessions}
        onClose={() => setStatsOpen(false)}
        onOpenSession={handleOpenSessionFromStats}
      />
      <Toaster
        theme={resolvedTheme}
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "border border-border bg-bg-secondary text-text-primary",
            description: "text-text-secondary",
          },
        }}
      />
    </div>
  );
}

export default App;
