import { useCallback, useEffect, useState } from "react";
import { toast, Toaster } from "sonner";
import { Sidebar } from "./components/sidebar";
import { TerminalTabs } from "./components/TerminalTabs";
import { CommandPalette } from "./components/CommandPalette";
import { StatsPanel } from "./components/stats/StatsPanel";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { useSettingsStore } from "./stores/settingsStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useHistoryStore } from "./stores/historyStore";
import { createPerfMarker } from "./lib/logger";
import "./App.css";

const appStartAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
let firstScreenPerfReported = false;

function App() {
  const loadSettings = useSettingsStore((s) => s.load);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const historySessions = useHistoryStore((s) => s.sessions);
  const loadHistorySessions = useHistoryStore((s) => s.loadSessions);
  const openHistoryWorkspace = useHistoryStore((s) => s.openHistory);
  const openHistorySession = useHistoryStore((s) => s.openSession);
  const [statsOpen, setStatsOpen] = useState(false);

  useKeyboardShortcuts();

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    document.documentElement.setAttribute("data-light-palette", lightThemePalette);
    document.documentElement.setAttribute("data-dark-palette", darkThemePalette);
  }, [resolvedTheme, lightThemePalette, darkThemePalette]);

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
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [resolvedTheme, historySessions.length]);

  return (
    <div className="flex h-screen flex-col bg-bg-primary">
      <a href="#main-content" className="skip-link">
        跳转到主内容
      </a>
      <WindowTitleBar />
      <div className="flex min-h-0 flex-1 -mt-px">
        <Sidebar onOpenStats={handleOpenStats} />
        <main id="main-content" className="flex min-w-0 flex-1 flex-col bg-bg-primary" tabIndex={-1}>
          <TerminalTabs />
        </main>
      </div>
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
