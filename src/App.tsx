import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast, Toaster } from "sonner";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/sidebar";
import { TerminalTabs } from "./components/TerminalTabs";
import { CommandPalette } from "./components/CommandPalette";
import type { SettingsTab } from "./components/SettingsModal";
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal }))
);
const StatsPanel = lazy(() =>
  import("./components/stats/StatsPanel").then((module) => ({ default: module.StatsPanel }))
);
const CcusageStatsPanel = lazy(() =>
  import("./components/stats/CcusageStatsPanel").then((module) => ({ default: module.CcusageStatsPanel }))
);
import { WindowTitleBar } from "./components/WindowTitleBar";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { AlertTriangle, Check, X } from "./components/icons";
import { useSettingsStore, type HookEventType } from "./stores/settingsStore";
import { useProjectStore } from "./stores/projectStore";
import { useSessionStore } from "./stores/sessionStore";
import { useSyncStore } from "./stores/syncStore";
import { useHistoryStore } from "./stores/historyStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useUpdateStore } from "./stores/updateStore";
import { useTerminalStore, type CliHookPayload } from "./stores/terminalStore";
import { useModelPricingStore } from "./stores/modelPricingStore";
import { createPerfMarker, logWarn } from "./lib/logger";
import { getContrastRatioFromHex, MIN_APPLY_CONTRAST_RATIO } from "./lib/contrast";
import { translateCurrent, useI18n } from "./lib/i18n";
import { getOsPlatform } from "./lib/shell";
import "./App.css";

const appStartAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
let firstScreenPerfReported = false;
let firstScreenShown = false;
let startupBaseReady = false;
let deferredStartupTasksStarted = false;
let startupUpdateChecked = false;
const COMPACT_WINDOW_WIDTH = 350;
const WINDOW_MIN_HEIGHT = 600;
const IN_TAURI = isTauri();
const CLAUDE_HOOK_TOAST_PREFIX = "claude-hook-notification";
let claudeHookToastSequence = 0;
type HookInstallStatus = "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";

function isLikelyMacOs() {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

interface HookSettingsStatusPayload {
  claude: { status: HookInstallStatus };
  codex: { status: HookInstallStatus };
  claudeAutoRepaired?: boolean;
}

interface SubagentTranscriptAppendPayload {
  key: string;
  content: string;
  reset: boolean;
}

async function hasInstalledCliHook(): Promise<boolean> {
  const settings = useSettingsStore.getState();
  const status = await invoke<HookSettingsStatusPayload>("hook_settings_get_status", {
    selectedDir: settings.claudeHookConfigDir?.trim() || null,
    codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
    ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
    autoRepair: settings.claudeHookAutoRepairKnownInstalled,
  });
  if (status.claudeAutoRepaired && !settings.claudeHookAutoRepairNoticeShown) {
    toast.info(translateCurrent("notifications.hook.autoRepaired.title"), {
      description: translateCurrent("notifications.hook.autoRepaired.description"),
    });
    void settings.update("claudeHookAutoRepairNoticeShown", true);
  }
  return status.claude.status === "installed" || status.codex.status === "installed";
}

type ClaudeHookToastVariant = "attention" | "approval" | "finished" | "failed";

interface ClaudeHookToastStyle {
  variant: ClaudeHookToastVariant;
  icon: typeof AlertTriangle;
  eyebrow: string;
  actionLabel: string;
}

interface ClaudeHookToastItem {
  id: string;
  title: string;
  message?: string;
  tabTitle: string;
  style: ClaudeHookToastStyle;
}

function canUseUiTextColor(textColor: string, backgroundColor: string): boolean {
  const ratio = getContrastRatioFromHex(textColor, backgroundColor);
  return ratio !== null && ratio >= MIN_APPLY_CONTRAST_RATIO;
}

function createClaudeHookToastId(tabId: string): string {
  claudeHookToastSequence += 1;
  return `${CLAUDE_HOOK_TOAST_PREFIX}-${tabId}-${claudeHookToastSequence}`;
}

function getClaudeHookToastStyle(payload: CliHookPayload): ClaudeHookToastStyle {
  if (payload.event === "Stop") {
    return { variant: "finished", icon: Check, eyebrow: translateCurrent("notifications.hookToast.finished"), actionLabel: translateCurrent("notifications.hookToast.view") };
  }
  if (payload.event === "StopFailure") {
    return { variant: "failed", icon: AlertTriangle, eyebrow: translateCurrent("notifications.hookToast.failed"), actionLabel: translateCurrent("notifications.hookToast.view") };
  }
  if (payload.event === "PermissionRequest") {
    return { variant: "approval", icon: AlertTriangle, eyebrow: translateCurrent("notifications.hookToast.approval"), actionLabel: translateCurrent("notifications.hookToast.handle") };
  }
  return { variant: "attention", icon: AlertTriangle, eyebrow: translateCurrent("notifications.hookToast.attention"), actionLabel: translateCurrent("notifications.hookToast.view") };
}

function getCliHookSourceName(payload: CliHookPayload): string {
  return payload.source === "codex" ? "Codex CLI" : "Claude Code";
}

function getClaudeHookToastTitle(payload: CliHookPayload, tabTitle: string): string {
  if (payload.title) return payload.title;
  const sourceName = getCliHookSourceName(payload);
  if (payload.event === "Stop") return translateCurrent("notifications.hookToast.title.finished", { tabTitle });
  if (payload.event === "StopFailure") return translateCurrent("notifications.hookToast.title.failed", { tabTitle });
  if (payload.event === "PermissionRequest") return translateCurrent("notifications.hookToast.title.approval", { sourceName });
  return translateCurrent("notifications.hookToast.title.attention", { sourceName });
}

function getHookProjectName(payload: CliHookPayload, tabTitle?: string | null): string {
  const normalizedTitle = tabTitle?.trim();
  if (normalizedTitle) return normalizedTitle;

  const cwd = payload.cwd?.trim();
  if (cwd) {
    const normalizedCwd = cwd.replace(/[\\/]+$/, "");
    const cwdParts = normalizedCwd.split(/[\\/]+/).filter(Boolean);
    return cwdParts.length > 0 ? cwdParts[cwdParts.length - 1] : cwd;
  }

  return translateCurrent("notifications.system.unknownProject");
}

function isSystemNotificationEvent(eventType: CliHookPayload["event"]): eventType is HookEventType {
  return (
    eventType === "SessionStart" ||
    eventType === "UserPromptSubmit" ||
    eventType === "Notification" ||
    eventType === "Stop" ||
    eventType === "StopFailure" ||
    eventType === "PermissionRequest"
  );
}

function getSystemNotificationBody(payload: CliHookPayload, projectName: string): string {
  const sourceName = getCliHookSourceName(payload);
  const detail = payload.message?.trim();
  const suffix = detail ? `: ${detail}` : "";

  switch (payload.event) {
    case "Stop":
      return translateCurrent("notifications.system.stop", { sourceName, projectName, suffix });
    case "StopFailure":
      return translateCurrent("notifications.system.stopFailure", { sourceName, projectName, suffix });
    case "PermissionRequest":
      return translateCurrent("notifications.system.permissionRequest", { sourceName, projectName, suffix });
    case "Notification":
      return translateCurrent("notifications.system.notification", { sourceName, projectName, suffix });
    case "SessionStart":
      return translateCurrent("notifications.system.sessionStart", { sourceName, projectName, suffix });
    case "UserPromptSubmit":
      return translateCurrent("notifications.system.userPromptSubmit", { sourceName, projectName, suffix });
    default:
      return translateCurrent("notifications.system.default", { sourceName, projectName, suffix });
  }
}

async function sendSystemNotification(payload: CliHookPayload, tabTitle?: string | null): Promise<void> {
  try {
    const settings = useSettingsStore.getState();
    if (!settings.systemNotificationsEnabled) return;
    if (!isSystemNotificationEvent(payload.event)) return;
    if (!settings.systemNotificationEvents[payload.event]) return;

    const projectName = getHookProjectName(payload, tabTitle);
    const title = "CLI-Manager";
    const body = getSystemNotificationBody(payload, projectName);

    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );

    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === "granted";
    }
    if (!permissionGranted) {
      console.warn("[System Notification] Permission not granted");
      return;
    }

    try {
      sendNotification({ title, body });
      return;
    } catch (notificationErr) {
      const isWsl = await invoke<boolean>("is_wsl").catch(() => false);
      if (!isWsl) throw notificationErr;
      await invoke("send_notification_via_windows", { title, body });
    }
  } catch (err) {
    console.warn("[System Notification] Failed to send:", err);
  }
}

function showClaudeHookToast(payload: CliHookPayload, tabId: string): void {
  const settings = useSettingsStore.getState();
  if (!settings.hookPopupNotificationsEnabled) return;

  const terminalStore = useTerminalStore.getState();
  const tabTitle = terminalStore.sessions.find((session) => session.id === tabId)?.title ?? getCliHookSourceName(payload);
  const item: ClaudeHookToastItem = {
    id: createClaudeHookToastId(tabId),
    title: getClaudeHookToastTitle(payload, tabTitle),
    message: payload.message ?? undefined,
    tabTitle,
    style: getClaudeHookToastStyle(payload),
  };
  const Icon = item.style.icon;

  toast.custom(
    () => (
      <div className="claude-hook-toast" data-variant={item.style.variant} data-tab-id={tabId}>
        <div className="claude-hook-toast__icon" aria-hidden="true">
          <Icon size={16} strokeWidth={2.4} />
        </div>
        <div className="claude-hook-toast__content">
          <div className="claude-hook-toast__eyebrow">{item.style.eyebrow}</div>
          <div className="claude-hook-toast__title">{item.title}</div>
          <div className="claude-hook-toast__source" title={item.tabTitle}>
            {translateCurrent("notifications.hookToast.from", { tabTitle: item.tabTitle })}
          </div>
          {item.message ? <div className="claude-hook-toast__description">{item.message}</div> : null}
          <div className="claude-hook-toast__actions">
            <button
              type="button"
              className="claude-hook-toast__action"
              onClick={() => {
                useHistoryStore.getState().closeHistory();
                useTerminalStore.getState().setActive(tabId);
                toast.dismiss(item.id);
              }}
            >
              {item.style.actionLabel}
            </button>
            <button type="button" className="claude-hook-toast__ignore" onClick={() => toast.dismiss(item.id)}>
              {translateCurrent("notifications.hookToast.ignore")}
            </button>
          </div>
        </div>
        <button
          type="button"
          className="claude-hook-toast__close"
          aria-label={translateCurrent("notifications.hookToast.close")}
          onClick={() => toast.dismiss(item.id)}
        >
          <X size={20} strokeWidth={2.2} />
        </button>
      </div>
    ),
    {
      id: item.id,
      duration: settings.hookPopupAutoCloseEnabled ? settings.hookPopupAutoCloseSeconds * 1000 : Infinity,
      position: "top-right",
    }
  );
}

function runDeferredStartupTasks(openSettings?: (tab?: SettingsTab) => void): void {
  if (!startupBaseReady || !firstScreenPerfReported || deferredStartupTasksStarted) return;
  deferredStartupTasksStarted = true;

  window.setTimeout(() => {
    void (async () => {
      const result = await useSyncStore.getState().runAutoSync("startup");
      if (result === "conflict") {
        toast.warning(translateCurrent("notifications.autoSync.startConflict"), {
          description: translateCurrent("notifications.autoSync.conflictDescription"),
        });
      } else if (result === "error") {
        toast.error(translateCurrent("notifications.autoSync.startFailed"), {
          description: translateCurrent("notifications.autoSync.failedDescription"),
        });
      }
    })();

    if (!startupUpdateChecked) {
      startupUpdateChecked = true;
      void (async () => {
        const updateStore = useUpdateStore.getState();
        await updateStore.fetchVersion();
        const updateInfo = await updateStore.checkUpdate({ silent: true });
        if (!updateInfo) return;
        toast.info(translateCurrent("notifications.update.availableTitle", { version: updateInfo.version }), {
          description: translateCurrent("notifications.update.availableDescription"),
          action: openSettings
            ? {
                label: translateCurrent("notifications.update.viewUpdate"),
                onClick: () => openSettings("general"),
              }
            : undefined,
          duration: 12000,
        });
      })();
    }
  }, 0);
}

function App() {
  const { language, t } = useI18n();
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiFontSize = useSettingsStore((s) => s.uiFontSize);
  const uiTextColor = useSettingsStore((s) => s.uiTextColor);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const ccusageAnalyticsEnabled = useSettingsStore((s) => s.ccusageAnalyticsEnabled);
  const lastSettingsTab = useSettingsStore((s) => s.lastSettingsTab);
  const updateSetting = useSettingsStore((s) => s.update);
  const openHistory = useHistoryStore((s) => s.openHistory);
  const openHistorySession = useHistoryStore((s) => s.openSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [statsOpen, setStatsOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [isMacOs, setIsMacOs] = useState(isLikelyMacOs);
  const terminalFullscreenMaximizedRef = useRef(false);
  const restoreWindowWidthRef = useRef<number | null>(null);
  const closeBehaviorRef = useRef(closeBehavior);

  const handleOpenSettings = useCallback((tab?: SettingsTab) => {
    const nextTab = tab ?? lastSettingsTab;
    setSettingsInitialTab(nextTab);
    if (tab && tab !== useSettingsStore.getState().lastSettingsTab) {
      void updateSetting("lastSettingsTab", tab);
    }
    setSettingsOpen(true);
    setSettingsEverOpened(true);
  }, [lastSettingsTab, updateSetting]);

  const handleSettingsTabChange = useCallback((tab: SettingsTab) => {
    if (tab !== useSettingsStore.getState().lastSettingsTab) {
      void updateSetting("lastSettingsTab", tab);
    }
  }, [updateSetting]);

  useEffect(() => {
    closeBehaviorRef.current = closeBehavior;
  }, [closeBehavior]);

  useEffect(() => {
    if (!IN_TAURI) return;
    void getOsPlatform()
      .then((platform) => setIsMacOs(platform === "macos"))
      .catch((err) => logWarn("Failed to read OS platform for window sizing", err));
  }, []);

  const runCloseAutoSync = useCallback(async () => {
    const result = await useSyncStore.getState().runAutoSync("close");
    if (result === "conflict") {
      toast.warning(t("notifications.autoSync.exitConflict"), {
        description: t("notifications.autoSync.conflictDescription"),
      });
    } else if (result === "error") {
      toast.error(t("notifications.autoSync.exitFailed"), {
        description: t("notifications.autoSync.failedDescription"),
      });
    }
  }, [t]);

  const handleOpenStats = useCallback(() => {
    // 历史用量分析（StatsPanel）不需要 hook，直接打开
    if (!ccusageAnalyticsEnabled) {
      setStatsOpen(true);
      return;
    }

    // 实时统计（CcusageStatsPanel）需要检查 hook 是否安装
    void (async () => {
      try {
        if (await hasInstalledCliHook()) {
          setStatsOpen(true);
          return;
        }
      } catch (err) {
        logWarn("Failed to check hook status before opening realtime stats", err);
      }

      toast.warning(t("notifications.stats.needHook"), {
        description: t("notifications.stats.needHookDescription"),
        action: {
          label: t("notifications.goSettings"),
          onClick: () => handleOpenSettings("hooks"),
        },
      });
    })();
  }, [ccusageAnalyticsEnabled, handleOpenSettings, t]);

  const handleOpenStatsSession = useCallback(
    async (sessionKey: string) => {
      await openHistory();
      await openHistorySession(sessionKey);
    },
    [openHistory, openHistorySession]
  );

  const handleToggleTerminalFullscreen = useCallback(() => {
    const nextFullscreen = !terminalFullscreen;
    if (!IN_TAURI) {
      setTerminalFullscreen(nextFullscreen);
      return;
    }

    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        if (nextFullscreen) {
          const alreadyMaximized = await appWindow.isMaximized();
          terminalFullscreenMaximizedRef.current = !alreadyMaximized;
          if (!alreadyMaximized) await appWindow.toggleMaximize();
        } else if (terminalFullscreenMaximizedRef.current) {
          await appWindow.unmaximize();
          terminalFullscreenMaximizedRef.current = false;
        }
        setTerminalFullscreen(nextFullscreen);
      } catch (err) {
        toast.error(nextFullscreen ? t("notifications.fullscreen.enterFailed") : t("notifications.fullscreen.exitFailed"), { description: String(err) });
        logWarn("Failed to toggle terminal fullscreen", err);
      }
    })();
  }, [terminalFullscreen, t]);

  useKeyboardShortcuts({ onToggleTerminalFullscreen: handleToggleTerminalFullscreen });

  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenHook = listen<CliHookPayload>("claude-hook-notification", (event) => {
      // SubagentStart / AgentToolStart：开/更新子 Agent 转录分屏，独立于 Tab 状态机与 toast。
      if (event.payload.event === "SubagentStart" || event.payload.event === "AgentToolStart") {
        void useTerminalStore.getState().openSubagentTranscript(event.payload);
        return;
      }
      if (event.payload.event === "AgentToolStop") {
        void useTerminalStore.getState().openSubagentTranscript(event.payload).finally(() => {
          useTerminalStore.getState().finishSubagentTranscript(event.payload);
        });
        return;
      }
      if (event.payload.event === "SubagentStop") {
        if (event.payload.agentTranscriptPath?.trim() || event.payload.source === "codex") {
          void useTerminalStore.getState().openSubagentTranscript(event.payload).finally(() => {
            useTerminalStore.getState().finishSubagentTranscript(event.payload);
          });
        } else {
          useTerminalStore.getState().finishSubagentTranscript(event.payload);
        }
        return;
      }
      const tabId = useTerminalStore.getState().handleCliHookEvent(event.payload);
      const terminalStore = useTerminalStore.getState();
      const tabTitle = tabId ? terminalStore.sessions.find((session) => session.id === tabId)?.title ?? null : null;
      // SessionStart 仅用于绑定 sessionId（无需用户介入），与 UserPromptSubmit 一样不弹 toast
      if (tabId && event.payload.event !== "UserPromptSubmit" && event.payload.event !== "SessionStart") {
        showClaudeHookToast(event.payload, tabId);
      }
      // 系统通知：并行发送（不影响应用内通知）
      void sendSystemNotification(event.payload, tabTitle);
    });
    // 子 Agent 转录 tail 增量：路由到对应转录面板。
    const unlistenTranscript = listen<SubagentTranscriptAppendPayload>("subagent-transcript-append", (event) => {
      const { key, content, reset } = event.payload;
      useTerminalStore.getState().appendSubagentTranscript(key, content, reset);
    });

    return () => {
      void unlistenHook.then((unlisten) => unlisten());
      void unlistenTranscript.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    const fallbackTimer = setTimeout(() => {
      if (!firstScreenShown) {
        firstScreenShown = true;
        void getCurrentWindow().show().catch((err) => logWarn("Failed to show window (fallback timeout)", err));
      }
    }, 3000);
    return () => clearTimeout(fallbackTimer);
  }, []);

  useEffect(() => {
    const init = async () => {
      // 1. 先加载设置，再并行加载依赖设置路径的子系统
      await loadSettings();
      await Promise.all([
        useSyncStore.getState().load(),
        useSessionStore.getState().load(),
      ]);
      void useModelPricingStore.getState().load().catch((err) => {
        logWarn("Failed to preload model pricing", err);
      });

      // 2. 加载项目列表
      await useProjectStore.getState().fetchAll();

      // 3. 启动时不恢复历史终端，避免重建 PTY 并重跑 startupCmd。
      await useSessionStore.getState().clear();

      startupBaseReady = true;
      runDeferredStartupTasks(handleOpenSettings);
    };
    init().catch((err) => {
      toast.error(t("notifications.app.initFailed"), { description: String(err) });
    });
  }, [handleOpenSettings, loadSettings, t]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    document.documentElement.setAttribute("data-light-palette", lightThemePalette);
    document.documentElement.setAttribute("data-dark-palette", darkThemePalette);
    document.documentElement.setAttribute("lang", language);
  }, [resolvedTheme, lightThemePalette, darkThemePalette, language]);

  useEffect(() => {
    const root = document.documentElement.style;
    const computedStyle = getComputedStyle(document.documentElement);
    const canApplyUiTextColor =
      uiTextColor !== "" && canUseUiTextColor(uiTextColor, computedStyle.getPropertyValue("--bg-primary"));

    if (canApplyUiTextColor) {
      root.setProperty("--text-primary", uiTextColor);
      root.setProperty("--text-secondary", `color-mix(in srgb, ${uiTextColor} 85%, var(--bg-primary))`);
      root.setProperty("--text-muted", `color-mix(in srgb, ${uiTextColor} 60%, var(--bg-primary))`);
    } else {
      root.removeProperty("--text-primary");
      root.removeProperty("--text-secondary");
      root.removeProperty("--text-muted");
    }
  }, [darkThemePalette, lightThemePalette, resolvedTheme, uiTextColor]);

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

  useEffect(() => {
    const root = document.documentElement.style;
    const bodySize = uiFontSize;
    const metaSize = Math.max(9, bodySize - 1);
    const microSize = Math.max(8, bodySize - 2);
    const textSmSize = bodySize + 1;
    const textBaseSize = bodySize + 3;

    root.setProperty("--font-size-ui", `${bodySize}px`);
    root.setProperty("--font-size-body", `${bodySize}px`);
    root.setProperty("--font-size-section-title", `${bodySize}px`);
    root.setProperty("--font-size-meta", `${metaSize}px`);
    root.setProperty("--font-size-micro", `${microSize}px`);
    root.setProperty("--font-size-app-title", `${bodySize + 2}px`);
    root.setProperty("--text-xs", `${metaSize}px`);
    root.setProperty("--text-sm", `${textSmSize}px`);
    root.setProperty("--text-base", `${textBaseSize}px`);
    root.setProperty("--mantine-font-size-xs", `${metaSize}px`);
    root.setProperty("--mantine-font-size-sm", `${textSmSize}px`);
    root.setProperty("--mantine-font-size-md", `${textBaseSize}px`);
    root.setProperty("--mantine-font-size-lg", `${bodySize + 5}px`);
    root.setProperty("--mantine-font-size-xl", `${bodySize + 7}px`);

    const styleId = "ui-font-size-override";
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      body {
        font-size: var(--font-size-body) !important;
        line-height: var(--line-height-body) !important;
      }
    `;
  }, [uiFontSize]);

  // 跟随系统主题：监听放在 effect 中，确保挂载/卸载严格成对，避免 store.load 中残留 listener
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => useSettingsStore.getState().syncSystemTheme();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const exitApp = useCallback(async (source: string) => {
    try {
      await getCurrentWindow().destroy();
    } catch (err) {
      logWarn(`Failed to destroy window from ${source}`, err);
      try {
        await exit(0);
      } catch (exitErr) {
        logWarn(`Failed to exit process from ${source}`, exitErr);
      }
    }
  }, []);

  const runExitCleanup = useCallback(async (source: string) => {
    try {
      await runCloseAutoSync();
      try {
        await invoke("pty_close_all");
      } catch (err) {
        logWarn("Failed to close PTY sessions before exit", err);
      }
      await useSessionStore.getState().clear();
    } finally {
      await exitApp(source);
    }
  }, [exitApp, runCloseAutoSync]);

  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenPromise = listen("tray-quit-requested", async () => {
      await runExitCleanup("tray quit");
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [runExitCleanup]);

  // 关闭窗口拦截：根据 closeBehavior 决定最小化到托盘 / 直接退出 / 弹窗询问
  useEffect(() => {
    if (!IN_TAURI) return;
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
        event.preventDefault();
        await runExitCleanup("window close");
        return;
      }
      event.preventDefault();
      setCloseDialogOpen(true);
    });

    return () => {
      unlistenPromise?.then((fn) => fn()).catch(() => {});
    };
  }, [runExitCleanup]);

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
        await runExitCleanup("close dialog");
      })();
    },
    [runExitCleanup, updateSetting]
  );

  useEffect(() => {
    if (!IN_TAURI || isMacOs) return;
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
  }, [isMacOs, viewMode, settingsOpen]);

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
        runDeferredStartupTasks(handleOpenSettings);
        if (IN_TAURI && !firstScreenShown) {
          firstScreenShown = true;
          void getCurrentWindow().show().catch((err) => logWarn("Failed to show window after first screen", err));
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [handleOpenSettings, resolvedTheme, viewMode]);

  if (!settingsLoaded) {
    return <div className="ui-workspace-shell flex h-screen flex-col" />;
  }

  return (
    <div className="ui-workspace-shell flex h-screen flex-col">
      <a href="#main-content" className="skip-link">
        {t("app.skipToMain")}
      </a>
      {(!terminalFullscreen || viewMode === "compact") && <WindowTitleBar />}
      {viewMode === "compact" ? (
        <div id="main-content" className="flex min-h-0 flex-1" tabIndex={-1}>
          <Sidebar
            onOpenSettings={handleOpenSettings}
            onOpenStats={handleOpenStats}
            compactMode
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!terminalFullscreen && (
            <Sidebar
              onOpenSettings={handleOpenSettings}
              onOpenStats={handleOpenStats}
            />
          )}
          <main id="main-content" className="ui-main-shell flex min-w-0 flex-1 flex-col" tabIndex={-1}>
            <TerminalTabs fullscreen={terminalFullscreen} onToggleFullscreen={handleToggleTerminalFullscreen} />
          </main>
        </div>
      )}
      <CommandPalette />
      <Suspense fallback={null}>
        {settingsEverOpened && (
          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            initialTab={settingsInitialTab}
            onActiveTabChange={handleSettingsTabChange}
          />
        )}
        {statsOpen &&
          (ccusageAnalyticsEnabled ? (
            <CcusageStatsPanel open={statsOpen} onClose={() => setStatsOpen(false)} />
          ) : (
            <StatsPanel
              open={statsOpen}
              onClose={() => setStatsOpen(false)}
              onOpenSession={handleOpenStatsSession}
            />
          ))}
      </Suspense>
      <CloseConfirmDialog
        open={closeDialogOpen}
        onMinimize={handleCloseDialogMinimize}
        onExit={handleCloseDialogExit}
        onClose={() => setCloseDialogOpen(false)}
      />
      <Toaster
        theme={resolvedTheme}
        position="bottom-right"
        expand
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
