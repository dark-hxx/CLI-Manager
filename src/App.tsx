import { useCallback, useEffect, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { isTauri } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/sidebar";
import { TerminalTabs } from "./components/TerminalTabs";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { useSettingsStore } from "./stores/settingsStore";
import { useProjectStore } from "./stores/projectStore";
import { useSessionStore } from "./stores/sessionStore";
import { useSyncStore } from "./stores/syncStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useUpdateStore } from "./stores/updateStore";
import { createPerfMarker, logWarn } from "./lib/logger";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

const appStartAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
let firstScreenPerfReported = false;
let startupUpdateChecked = false;
const COMPACT_WINDOW_WIDTH = 350;
const WINDOW_MIN_HEIGHT = 600;
const IN_TAURI = isTauri();

function App() {
  const loadSettings = useSettingsStore((s) => s.load);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiTextColor = useSettingsStore((s) => s.uiTextColor);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const updateSetting = useSettingsStore((s) => s.update);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const restoreWindowWidthRef = useRef<number | null>(null);
  const closeBehaviorRef = useRef(closeBehavior);

  useEffect(() => {
    closeBehaviorRef.current = closeBehavior;
  }, [closeBehavior]);

  useKeyboardShortcuts();

  useEffect(() => {
    const init = async () => {
      // 1. 并行加载相互独立的子系统：设置、同步配置、会话持久化
      await Promise.all([
        loadSettings(),
        useSyncStore.getState().load(),
        useSessionStore.getState().load(),
      ]);

      // 2. 加载项目列表
      await useProjectStore.getState().fetchAll();

      // 3. 启动时不恢复历史终端，避免重建 PTY 并重跑 startupCmd。
      await useSessionStore.getState().clear();

      if (!startupUpdateChecked) {
        startupUpdateChecked = true;
        void (async () => {
          const updateStore = useUpdateStore.getState();
          await updateStore.fetchVersion();
          const updateInfo = await updateStore.checkUpdate({ silent: true });
          if (!updateInfo) return;
          toast.info(`发现新版本 V${updateInfo.version}`, {
            description: "点击前往 Release 页面下载更新",
            action: updateInfo.downloadUrl
              ? {
                  label: "前往更新",
                  onClick: () => {
                    void openUrl(updateInfo.downloadUrl);
                  },
                }
              : undefined,
            duration: 12000,
          });
        })();
      }
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

  useEffect(() => {
    const root = document.documentElement.style;
    if (uiTextColor) {
      root.setProperty("--text-primary", uiTextColor);
      root.setProperty(
        "--text-secondary",
        `color-mix(in srgb, ${uiTextColor} 85%, var(--bg-primary))`
      );
      root.setProperty(
        "--text-muted",
        `color-mix(in srgb, ${uiTextColor} 60%, var(--bg-primary))`
      );
    } else {
      root.removeProperty("--text-primary");
      root.removeProperty("--text-secondary");
      root.removeProperty("--text-muted");
    }
  }, [uiTextColor]);

  useEffect(() => {
    if (uiFontFamily) {
      document.documentElement.style.setProperty("--font-ui-sans", uiFontFamily);
      document.documentElement.style.setProperty("--font-ui-mono", uiFontFamily);
      document.documentElement.style.fontFamily = uiFontFamily;
    } else {
      document.documentElement.style.removeProperty("--font-ui-sans");
      document.documentElement.style.removeProperty("--font-ui-mono");
      document.documentElement.style.fontFamily = "";
    }

    const styleId = "ui-font-family-override";
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    if (uiFontFamily) {
      styleEl.textContent = `
        html, body, #root, button, input, select, textarea, optgroup,
        [class*="font-sans"], [class*="font-mono"], code, pre, kbd, samp,
        .ui-mono, .ui-dev-label {
          font-family: ${uiFontFamily} !important;
        }
        .xterm, .xterm *, .xterm-helper-textarea {
          font-family: revert !important;
        }
      `;
    } else {
      styleEl.textContent = "";
    }
  }, [uiFontFamily]);

  // 跟随系统主题：监听放在 effect 中，确保挂载/卸载严格成对，避免 store.load 中残留 listener
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => useSettingsStore.getState().syncSystemTheme();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenPromise = listen("tray-quit-requested", async () => {
      try {
        await useSessionStore.getState().clear();
      } finally {
        try {
          await getCurrentWindow().destroy();
        } catch (err) {
          logWarn("Failed to destroy window from tray quit", err);
        }
      }
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // 关闭窗口拦截：根据 closeBehavior 决定最小化到托盘 / 直接退出 / 弹窗询问
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlistenPromise: Promise<() => void> | null = null;

    unlistenPromise = appWindow.onCloseRequested(async (event) => {
      const behavior = closeBehaviorRef.current;
      if (behavior === "minimize") {
        event.preventDefault();
        try {
          await appWindow.hide();
        } catch (err) {
          logWarn("Failed to hide window on close", err);
        }
        return;
      }
      if (behavior === "exit") {
        await useSessionStore.getState().clear();
        return;
      }
      event.preventDefault();
      setCloseDialogOpen(true);
    });

    return () => {
      unlistenPromise?.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const handleCloseDialogMinimize = useCallback(
    (remember: boolean) => {
      setCloseDialogOpen(false);
      if (remember) {
        void updateSetting("closeBehavior", "minimize");
      }
      void (async () => {
        try {
          await getCurrentWindow().hide();
        } catch (err) {
          logWarn("Failed to hide window from dialog", err);
        }
      })();
    },
    [updateSetting]
  );

  const handleCloseDialogExit = useCallback(
    (remember: boolean) => {
      setCloseDialogOpen(false);
      if (remember) {
        void updateSetting("closeBehavior", "exit");
      }
      void (async () => {
        try {
          await useSessionStore.getState().clear();
        } finally {
          try {
            await getCurrentWindow().destroy();
          } catch (err) {
            logWarn("Failed to destroy window from dialog", err);
          }
        }
      })();
    },
    [updateSetting]
  );

  useEffect(() => {
    if (!IN_TAURI) return;
    const appWindow = getCurrentWindow();
    void (async () => {
      try {
        const shouldPreserveWindowBounds =
          (await appWindow.isMaximized()) || (await appWindow.isFullscreen());
        if (shouldPreserveWindowBounds) return;
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
        if (settingsOpen) {
          await appWindow.setMinSize(new LogicalSize(800, WINDOW_MIN_HEIGHT));
          const targetWidth = Math.max(restoreWindowWidthRef.current ?? 800, 800);
          await appWindow.setSize(
            new LogicalSize(targetWidth, Math.max(window.innerHeight, WINDOW_MIN_HEIGHT))
          );
          return;
        }
        await appWindow.setMinSize(new LogicalSize(COMPACT_WINDOW_WIDTH, WINDOW_MIN_HEIGHT));
        await appWindow.setSize(
          new LogicalSize(COMPACT_WINDOW_WIDTH, Math.max(window.innerHeight, WINDOW_MIN_HEIGHT))
        );
      } catch (err) {
        logWarn("Failed to adjust window size", err);
      }
    })();
  }, [viewMode, settingsOpen]);

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
          viewMode,
        });
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [resolvedTheme, viewMode]);

  return (
    <div className="ui-workspace-shell flex h-screen flex-col">
      <a href="#main-content" className="skip-link">
        跳转到主内容
      </a>
      <WindowTitleBar />
      {viewMode === "compact" ? (
        <div id="main-content" className="flex min-h-0 flex-1" tabIndex={-1}>
          <Sidebar
            onOpenSettings={(tab) => {
              setSettingsInitialTab(tab ?? "general");
              setSettingsOpen(true);
            }}
            compactMode
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Sidebar
            onOpenSettings={(tab) => {
              setSettingsInitialTab(tab ?? "general");
              setSettingsOpen(true);
            }}
          />
          <main id="main-content" className="ui-main-shell flex min-w-0 flex-1 flex-col" tabIndex={-1}>
            <TerminalTabs />
          </main>
        </div>
      )}
      <CommandPalette />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab={settingsInitialTab} />
      <CloseConfirmDialog
        open={closeDialogOpen}
        onMinimize={handleCloseDialogMinimize}
        onExit={handleCloseDialogExit}
        onClose={() => setCloseDialogOpen(false)}
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
