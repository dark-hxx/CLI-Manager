import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast, Toaster } from "sonner";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/sidebar";
import { TerminalTabs } from "./components/TerminalTabs";
import { CommandPalette } from "./components/CommandPalette";
import type { LucideIcon } from "lucide-react";
import type { SettingsTab } from "./components/SettingsModal";
const loadSettingsModal = () => import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal }));
const SettingsModal = lazy(loadSettingsModal);
const StatsPanel = lazy(() =>
  import("./components/stats/StatsPanel").then((module) => ({ default: module.StatsPanel }))
);
const CcusageStatsPanel = lazy(() =>
  import("./components/stats/CcusageStatsPanel").then((module) => ({ default: module.CcusageStatsPanel }))
);
import { WindowTitleBar } from "./components/WindowTitleBar";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { RunningTasksExitDialog } from "./components/RunningTasksExitDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ExitProgressOverlay, type ExitPhase } from "./components/ExitProgressOverlay";
import { AppFailureState } from "./components/AppFailureState";
import { ExternalSessionSyncDialog } from "./components/ExternalSessionSyncDialog";
import { CircleAlert, CircleCheck, Info, ShieldAlert, X } from "./components/icons";
import { useSettingsStore, type HookEventType } from "./stores/settingsStore";
import { useProjectStore } from "./stores/projectStore";
import { useSessionStore } from "./stores/sessionStore";
import { flushTerminalSnapshotsNow } from "./lib/sessionSnapshotPersistence";
import { useSyncStore } from "./stores/syncStore";
import { useHistoryStore } from "./stores/historyStore";
import { useExternalSessionSyncStore } from "./stores/externalSessionSyncStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useDesktopPetCoordinator } from "./hooks/useDesktopPetCoordinator";
import { useRemoteHandoffCoordinator } from "./hooks/useRemoteHandoffCoordinator";
import { useUpdateStore } from "./stores/updateStore";
import { useReplayStore } from "./stores/replayStore";
import { useTerminalStore, type CliHookPayload } from "./stores/terminalStore";
import { useModelPricingStore } from "./stores/modelPricingStore";
import { useWorktreeStore } from "./stores/worktreeStore";
import { debugConsoleWarn } from "./lib/debugConsole";
import { createPerfMarker, logInfo, logWarn } from "./lib/logger";
import { getContrastRatioFromHex, MIN_APPLY_CONTRAST_RATIO } from "./lib/contrast";
import { getDb } from "./lib/db";
import { translateCurrent, useI18n } from "./lib/i18n";
import { getOsPlatform } from "./lib/shell";
import { normalizeFontFamilyStack } from "./lib/systemFonts";
import { ALL_TERMINALS_SCOPE } from "./lib/terminalScope";
import { cleanupTerminalProcessesForExit } from "./lib/terminalExitCleanup";
import { shouldIncludeDaemonExitTask } from "./lib/terminalExitTask";
import { requestSidebarToggle } from "./lib/sidebarCommands";
import { getTerminalTheme, isLightTerminalTheme } from "./lib/terminalThemes";
import { resolveProjectForSession } from "./lib/terminalProject";
import { terminalProcessManager } from "./terminal/core/TerminalProcessManager";
import type { TerminalScope } from "./lib/types";
import "./App.css";

const appStartAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
let firstScreenPerfReported = false;
let firstScreenShown = false;
let startupBaseReady = false;
// React StrictMode/初始化重入下，每个应用进程最多展示一次恢复提示。
let deferredStartupTasksStarted = false;
let startupUpdateChecked = false;
let settingsModalPreloadStarted = false;
const COMPACT_WINDOW_WIDTH = 350;
const WINDOW_MIN_HEIGHT = 600;
interface DaemonSessionMeta {
  sessionId: string;
  alive: boolean;
  taskStatus?: string | null;
}

const TERMINAL_PANEL_SEMANTIC_COLORS = {
  dark: {
    fg: "#ECECEC",
    dim: "#9CA0A6",
    green: "#3DD68C",
    yellow: "#E5C453",
    red: "#F25E5E",
    magenta: "#C77DBB",
    cyan: "#5AC8E0",
    blue: "#5B8DEF",
  },
  light: {
    fg: "#1F2937",
    dim: "#64748B",
    green: "#15803D",
    yellow: "#B45309",
    red: "#DC2626",
    magenta: "#9333EA",
    cyan: "#0891B2",
    blue: "#2563EB",
  },
} as const;
// 关闭期自动同步上限：封顶最坏退出时间（WebDAV 客户端本身有 30s HTTP 超时）。
const CLOSE_SYNC_TIMEOUT_MS = 8000;
// 退出遮罩上 conflict/error 提示的停留时长，之后继续退出流程。
const EXIT_NOTICE_DISPLAY_MS = 1200;
const STARTUP_STAGE_TIMEOUT_MS = 15_000;
const REQUEST_LOG_SYNC_INTERVAL_MS = 60_000;
const IN_TAURI = isTauri();
const CLAUDE_HOOK_TOAST_PREFIX = "claude-hook-notification";
const SYSTEM_NOTIFICATION_ACTION_EVENT = "system-notification-action";
const MAX_SYSTEM_NOTIFICATION_DETAIL_LENGTH = 72;
let claudeHookToastSequence = 0;
type HookInstallStatus = "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";
type StartupStage = "settings" | "stores" | "projects";

function isLikelyMacOs() {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function preloadSettingsModal(): void {
  if (settingsModalPreloadStarted) return;
  settingsModalPreloadStarted = true;
  void loadSettingsModal().catch((err) => {
    settingsModalPreloadStarted = false;
    logWarn("Failed to preload settings modal", err);
  });
}

interface HookSettingsStatusPayload {
  claude: { status: HookInstallStatus };
  codex: { status: HookInstallStatus };
  pi: { status: HookInstallStatus };
  grok: { status: HookInstallStatus };
  claudeAutoRepaired?: boolean;
}

interface SubagentTranscriptAppendPayload {
  key: string;
  content: string;
  reset: boolean;
}

interface SystemNotificationActionPayload {
  tabId: string;
}

async function hasInstalledCliHook(): Promise<boolean> {
  const settings = useSettingsStore.getState();
  const status = await invoke<HookSettingsStatusPayload>("hook_settings_get_status", {
    selectedDir: settings.claudeHookConfigDir?.trim() || null,
    codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
    piSelectedDir: settings.piHookConfigDir?.trim() || null,
    grokSelectedDir: settings.grokHookConfigDir?.trim() || null,
    ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
    autoRepair: settings.claudeHookBridgeEnabled && settings.claudeHookAutoRepairKnownInstalled,
  });
  if (status.claudeAutoRepaired && !settings.claudeHookAutoRepairNoticeShown) {
    toast.info(translateCurrent("notifications.hook.autoRepaired.title"), {
      description: translateCurrent("notifications.hook.autoRepaired.description"),
    });
    void settings.update("claudeHookAutoRepairNoticeShown", true);
  }
  return (
    (settings.claudeHookBridgeEnabled && status.claude.status === "installed") ||
    (settings.codexHookBridgeEnabled && status.codex.status === "installed") ||
    (settings.piHookBridgeEnabled && status.pi.status === "installed") ||
    (settings.grokHookBridgeEnabled && status.grok.status === "installed")
  );
}

type ClaudeHookToastVariant = "attention" | "approval" | "finished" | "failed";

interface ClaudeHookToastStyle {
  variant: ClaudeHookToastVariant;
  icon: LucideIcon;
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
    return { variant: "finished", icon: CircleCheck, eyebrow: translateCurrent("notifications.hookToast.finished"), actionLabel: translateCurrent("notifications.hookToast.view") };
  }
  if (payload.event === "StopFailure") {
    return { variant: "failed", icon: CircleAlert, eyebrow: translateCurrent("notifications.hookToast.failed"), actionLabel: translateCurrent("notifications.hookToast.view") };
  }
  if (payload.event === "PermissionRequest") {
    return { variant: "approval", icon: ShieldAlert, eyebrow: translateCurrent("notifications.hookToast.approval"), actionLabel: translateCurrent("notifications.hookToast.handle") };
  }
  return { variant: "attention", icon: Info, eyebrow: translateCurrent("notifications.hookToast.attention"), actionLabel: translateCurrent("notifications.hookToast.view") };
}

function getCliHookSourceName(payload: CliHookPayload): string {
  if (payload.source === "codex") return "Codex CLI";
  if (payload.source === "pi") return "Pi Agent";
  if (payload.source === "grok") return "Grok Build";
  return "Claude Code";
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

function truncateSystemNotificationDetail(detail: string): string {
  if (detail.length <= MAX_SYSTEM_NOTIFICATION_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_SYSTEM_NOTIFICATION_DETAIL_LENGTH - 3).trimEnd()}...`;
}

function getSystemNotificationBody(payload: CliHookPayload, projectName: string): string {
  const sourceName = getCliHookSourceName(payload);
  const detail = payload.message?.trim();
  const suffix = detail ? `: ${truncateSystemNotificationDetail(detail)}` : "";

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

async function focusMainWindow(): Promise<void> {
  if (!IN_TAURI) return;
  try {
    await invoke("app_show_main_window");
  } catch (err) {
    logWarn("Failed to show main window", err);
  }
}

// 后台任务模式（Issue #123 Phase 1）：退出时选择"转入后台继续执行"后置 true，
// 窗口重新获得焦点后清除。模块级标记，供 sendSystemNotification 切换通知策略。
let backgroundTaskModeActive = false;

async function isMainWindowFocused(): Promise<boolean> {
  if (!IN_TAURI) return false;
  try {
    return await getCurrentWindow().isFocused();
  } catch (err) {
    logWarn("Failed to read main window focus state", err);
    return false;
  }
}

type HookNotificationTargetActivator = (tabId: string) => void | Promise<void>;

async function sendSystemNotification(payload: CliHookPayload, tabId: string | null, tabTitle?: string | null): Promise<void> {
  try {
    const settings = useSettingsStore.getState();
    if (!isSystemNotificationEvent(payload.event)) return;
    if (!tabId) return;
    // 后台任务模式下通知必发：绕过总开关/事件开关/聚焦抑制，
    // 否则用户无从得知任务已完成或卡在等待确认（Issue #123 Phase 1）。
    if (!backgroundTaskModeActive) {
      if (!settings.systemNotificationsEnabled) return;
      if (!settings.systemNotificationEvents[payload.event]) return;
      if (settings.suppressSystemNotificationsWhenFocused && (await isMainWindowFocused())) return;
    }

    const projectName = getHookProjectName(payload, tabTitle);
    const title = "CLI-Manager";
    const body = getSystemNotificationBody(payload, projectName);
    const actionLabel = getClaudeHookToastStyle(payload).actionLabel;

    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );

    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === "granted";
    }
    if (!permissionGranted) {
      debugConsoleWarn("[System Notification] Permission not granted");
      return;
    }

    try {
      await invoke("send_interactive_system_notification", { title, body, tabId, actionLabel });
      return;
    } catch (notificationErr) {
      const isWsl = await invoke<boolean>("is_wsl").catch(() => false);
      if (!isWsl) throw notificationErr;
      await invoke("send_notification_via_windows", { title, body });
    }
  } catch (err) {
    debugConsoleWarn("[System Notification] Failed to send:", err);
  }
}

function showClaudeHookToast(payload: CliHookPayload, tabId: string, onActivateTarget: HookNotificationTargetActivator): void {
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
          <div className="claude-hook-toast__title">{item.style.eyebrow}</div>
          <div className="claude-hook-toast__source" title={item.tabTitle}>
            {item.title} · {translateCurrent("notifications.hookToast.from", { tabTitle: item.tabTitle })}
          </div>
          {item.message ? <div className="claude-hook-toast__description">{item.message}</div> : null}
        </div>
        <button
          type="button"
          className="claude-hook-toast__action"
          onClick={() => {
            void onActivateTarget(tabId);
            toast.dismiss(item.id);
          }}
        >
          {item.style.actionLabel}
        </button>
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
      position: "bottom-right",
    }
  );
}

function runDeferredStartupTasks(openSettings?: (tab?: SettingsTab) => void): void {
  if (!startupBaseReady || !firstScreenPerfReported || deferredStartupTasksStarted) return;
  deferredStartupTasksStarted = true;

  window.setTimeout(() => {
    window.setTimeout(preloadSettingsModal, 250);

    void (async () => {
      await useProjectStore.getState().refreshProjectDiagnostics().catch((err) => {
        logWarn("Failed to refresh deferred project diagnostics", err);
      });

      await useSyncStore.getState().load();
      await useSyncStore.getState().retryOutbox();
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
                onClick: () => openSettings("about"),
              }
            : undefined,
          duration: 12000,
        });
      })();
    }

    window.setTimeout(() => {
      const startExternalSessionSync = () => {
        useExternalSessionSyncStore.getState().startMonitor();
      };
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(startExternalSessionSync, { timeout: 3000 });
      } else {
        startExternalSessionSync();
      }
    }, 5000);
  }, 0);
}

function App() {
  const { language, t } = useI18n();
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiFontSize = useSettingsStore((s) => s.uiFontSize);
  const uiTextColor = useSettingsStore((s) => s.uiTextColor);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const exitWithRunningTasksBehavior = useSettingsStore((s) => s.exitWithRunningTasksBehavior);
  const ccusageAnalyticsEnabled = useSettingsStore((s) => s.ccusageAnalyticsEnabled);
  const claudeHookConfigDir = useSettingsStore((s) => s.claudeHookConfigDir);
  const codexHookConfigDir = useSettingsStore((s) => s.codexHookConfigDir);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const projectScopedTerminalViewEnabled = useSettingsStore((s) => s.projectScopedTerminalViewEnabled);
  const lastSettingsTab = useSettingsStore((s) => s.lastSettingsTab);
  const updateSetting = useSettingsStore((s) => s.update);
  const openHistory = useHistoryStore((s) => s.openHistory);
  const openHistorySession = useHistoryStore((s) => s.openSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  const [settingsWindowExpanded, setSettingsWindowExpanded] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [statsOpen, setStatsOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [runningTasksDialogOpen, setRunningTasksDialogOpen] = useState(false);
  const [runningTasksCount, setRunningTasksCount] = useState(0);
  const [exitPhase, setExitPhase] = useState<ExitPhase | null>(null);
  const [exitNotice, setExitNotice] = useState<string | null>(null);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [terminalScope, setTerminalScope] = useState<TerminalScope>(ALL_TERMINALS_SCOPE);
  const [isMacOs, setIsMacOs] = useState(isLikelyMacOs);
  const [initError, setInitError] = useState<string | null>(null);
  const [startupStage, setStartupStage] = useState<StartupStage>("settings");
  const [startupReady, setStartupReady] = useState(false);
  const [restorePromptOpen, setRestorePromptOpen] = useState(false);
  // 启动时若检测到上次遗留的可恢复工作区标签，弹窗询问是否恢复（Issue #123）。
  const terminalFullscreenMaximizedRef = useRef(false);
  const restoreWindowWidthRef = useRef<number | null>(null);
  const closeBehaviorRef = useRef(closeBehavior);
  const exitTasksBehaviorRef = useRef(exitWithRunningTasksBehavior);
  const pendingExitDaemonSessionsCheckedRef = useRef(false);
  const pendingExitSourceRef = useRef("window close");

  const handleOpenSettings = useCallback((tab?: SettingsTab) => {
    const nextTab = tab ?? lastSettingsTab;
    preloadSettingsModal();
    setSettingsInitialTab(nextTab);
    if (tab && tab !== useSettingsStore.getState().lastSettingsTab) {
      void updateSetting("lastSettingsTab", tab);
    }
    setSettingsWindowExpanded(true);
    setSettingsOpen(true);
    setSettingsEverOpened(true);
  }, [lastSettingsTab, updateSetting]);

  const handleSettingsTabChange = useCallback((tab: SettingsTab) => {
    if (tab !== useSettingsStore.getState().lastSettingsTab) {
      void updateSetting("lastSettingsTab", tab);
    }
  }, [updateSetting]);

  const startupOpenSettingsRef = useRef(handleOpenSettings);
  const startupTranslateRef = useRef(t);
  useEffect(() => {
    startupOpenSettingsRef.current = handleOpenSettings;
    startupTranslateRef.current = t;
  }, [handleOpenSettings, t]);

  useEffect(() => {
    closeBehaviorRef.current = closeBehavior;
  }, [closeBehavior]);

  useEffect(() => {
    if (!IN_TAURI || !settingsLoaded || !startupReady) return;
    let disposed = false;
    let syncing = false;

    const syncRequestLogs = async () => {
      if (disposed || syncing) return;
      syncing = true;
      try {
        await getDb();
        if (disposed) return;
        await invoke("history_sync_request_logs", {
          claudeConfigDir: claudeHookConfigDir?.trim() || null,
          codexConfigDir: codexHookConfigDir?.trim() || null,
          force: false,
        });
      } catch (err) {
        logWarn("Failed to sync local request logs", err);
      } finally {
        syncing = false;
      }
    };

    void syncRequestLogs();
    const timer = window.setInterval(() => void syncRequestLogs(), REQUEST_LOG_SYNC_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [claudeHookConfigDir, codexHookConfigDir, settingsLoaded, startupReady]);

  useEffect(() => {
    exitTasksBehaviorRef.current = exitWithRunningTasksBehavior;
  }, [exitWithRunningTasksBehavior]);

  useEffect(() => {
    if (!projectScopedTerminalViewEnabled) {
      setTerminalScope(ALL_TERMINALS_SCOPE);
    }
  }, [projectScopedTerminalViewEnabled]);

  useEffect(() => {
    if (!IN_TAURI) return;
    void getOsPlatform()
      .then((platform) => setIsMacOs(platform === "macos"))
      .catch((err) => logWarn("Failed to read OS platform for window sizing", err));
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    const handleF12 = (event: KeyboardEvent) => {
      if (event.key !== "F12") return;
      event.preventDefault();
      event.stopPropagation();
      if (!debugMode) return;
      void invoke("app_open_devtools").catch((err) => logWarn("Failed to open devtools", err));
    };
    window.addEventListener("keydown", handleF12, true);
    return () => window.removeEventListener("keydown", handleF12, true);
  }, [debugMode]);

  // 关闭期自动备份：先落本地 outbox，再在 8s 内尝试上传；超时后下次启动重试。
  const runCloseAutoSync = useCallback(async () => {
    const showExitNotice = async (message: string) => {
      setExitNotice(message);
      await new Promise((resolve) => setTimeout(resolve, EXIT_NOTICE_DISPLAY_MS));
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), CLOSE_SYNC_TIMEOUT_MS);
    });
    try {
      await useSyncStore.getState().load();
      const result = await Promise.race([useSyncStore.getState().runCloseAutoBackup(), timeoutPromise]);
      if (result === "timeout") {
        logWarn("Close auto sync timed out, continuing exit", { timeoutMs: CLOSE_SYNC_TIMEOUT_MS });
        await showExitNotice(t("app.exitProgress.syncTimeout"));
        return;
      }
      if (result === "error") {
        logWarn("Close auto backup failed, continuing exit");
        await showExitNotice(t("app.exitProgress.syncFailed"));
      }
    } catch (err) {
      logWarn("Close auto sync threw, continuing exit", err);
      await showExitNotice(t("app.exitProgress.syncFailed"));
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
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

  const handleToggleSidebarShortcut = useCallback(() => {
    if (terminalFullscreen) {
      handleToggleTerminalFullscreen();
      return;
    }
    requestSidebarToggle();
  }, [handleToggleTerminalFullscreen, terminalFullscreen]);

  const handleActivateHookNotificationTarget = useCallback(async (tabId: string) => {
    const terminalStore = useTerminalStore.getState();
    const targetSession = terminalStore.sessions.find((session) => session.id === tabId);
    if (!targetSession) {
      toast.warning(translateCurrent("notifications.system.targetClosed"));
      return;
    }

    useHistoryStore.getState().closeHistory();
    if (useSettingsStore.getState().projectScopedTerminalViewEnabled) {
      const projects = useProjectStore.getState().projects;
      const projectById = new Map(projects.map((project) => [project.id, project]));
      const targetProjectId = resolveProjectForSession(
        targetSession,
        terminalStore.sessions,
        projects,
        projectById
      )?.id ?? null;
      flushSync(() => {
        setTerminalScope(
          targetProjectId && targetSession.worktreeId
            ? { kind: "worktree", projectId: targetProjectId, worktreeId: targetSession.worktreeId }
            : targetProjectId
              ? { kind: "project", projectId: targetProjectId }
              : ALL_TERMINALS_SCOPE
        );
      });
    }
    terminalStore.setActive(tabId);

    // 只在窗口未聚焦时才切换窗口，避免 PermissionRequest 等事件在用户专注其他工作时强制打断
    const isFocused = await isMainWindowFocused();
    if (!isFocused) {
      await focusMainWindow();
    }
  }, []);

  useRemoteHandoffCoordinator(startupReady);

  useDesktopPetCoordinator({
    appReady: startupReady,
    terminalFullscreen,
    onOpenSettings: () => handleOpenSettings("desktop-pet"),
    onActivateSession: handleActivateHookNotificationTarget,
  });

  useKeyboardShortcuts({
    onToggleSidebar: handleToggleSidebarShortcut,
    onToggleTerminalFullscreen: handleToggleTerminalFullscreen,
  });

  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenHook = listen<CliHookPayload>("claude-hook-notification", (event) => {
      void useReplayStore.getState().recordCliHookEvent(event.payload);
      const isClaudeToolSubagentEvent =
        event.payload.source === "claude" &&
        (event.payload.event === "ToolStart" || event.payload.event === "ToolStop") &&
        Boolean(event.payload.agentId?.trim());
      const supportsLocalSubagentTranscript = event.payload.environmentType !== "ssh";

      // SubagentStart / AgentToolStart：开/更新子 Agent 转录分屏，独立于 Tab 状态机与 toast。
      if (supportsLocalSubagentTranscript && (event.payload.event === "SubagentStart" || event.payload.event === "AgentToolStart" || isClaudeToolSubagentEvent)) {
        void useTerminalStore.getState().openSubagentTranscript(event.payload);
        return;
      }
      if (supportsLocalSubagentTranscript && event.payload.event === "AgentToolStop") {
        void useTerminalStore.getState().openSubagentTranscript(event.payload).finally(() => {
          useTerminalStore.getState().finishSubagentTranscript(event.payload);
        });
        return;
      }
      if (supportsLocalSubagentTranscript && event.payload.event === "SubagentStop") {
        if (event.payload.agentTranscriptPath?.trim() || event.payload.source === "codex") {
          void useTerminalStore.getState().openSubagentTranscript(event.payload).finally(() => {
            useTerminalStore.getState().finishSubagentTranscript(event.payload);
          });
        } else {
          useTerminalStore.getState().finishSubagentTranscript(event.payload);
        }
        return;
      }
      const boundTabId = useTerminalStore.getState().handleCliHookEvent(event.payload);
      // External hooks (no PTY tab env) still carry a synthetic tabId like external:grok:<session>.
      // Prefer bound session when present; otherwise fall back so toast/system notifications still fire.
      const tabId = boundTabId ?? event.payload.tabId?.trim() ?? null;
      const terminalStore = useTerminalStore.getState();
      const tabTitle = boundTabId
        ? terminalStore.sessions.find((session) => session.id === boundTabId)?.title ?? null
        : null;
      // SessionStart/UserPromptSubmit 只更新状态；普通工具生命周期事件不打扰用户。
      if (
        tabId &&
        event.payload.event !== "UserPromptSubmit" &&
        event.payload.event !== "SessionStart" &&
        event.payload.event !== "ToolStart" &&
        event.payload.event !== "ToolStop"
      ) {
        showClaudeHookToast(event.payload, tabId, handleActivateHookNotificationTarget);
      }
      // 系统通知：并行发送（不影响应用内通知）
      void sendSystemNotification(event.payload, tabId, tabTitle);
    });
    const unlistenSystemNotification = listen<SystemNotificationActionPayload>(SYSTEM_NOTIFICATION_ACTION_EVENT, (event) => {
      void handleActivateHookNotificationTarget(event.payload.tabId);
    });
    const unlistenSshHookGap = listen<{ hostId: string; dropped: number }>("ssh-agent-hook-gap", (event) => {
      toast.warning(t("terminal.ssh.hookGap", { count: event.payload.dropped }));
    });
    // 子 Agent 转录 tail 增量：路由到对应转录面板。
    const unlistenTranscript = listen<SubagentTranscriptAppendPayload>("subagent-transcript-append", (event) => {
      const { key, content, reset } = event.payload;
      useTerminalStore.getState().appendSubagentTranscript(key, content, reset);
    });

    return () => {
      void unlistenHook.then((unlisten) => unlisten());
      void unlistenSystemNotification.then((unlisten) => unlisten());
      void unlistenSshHookGap.then((unlisten) => unlisten());
      void unlistenTranscript.then((unlisten) => unlisten());
    };
  }, [handleActivateHookNotificationTarget, t]);

  useEffect(() => {
    if (!IN_TAURI) return;
    let cancelled = false;
    const activate = async (sessionId: string) => {
      if (!sessionId || cancelled) return;
      try {
        const restored = await useTerminalStore.getState().attachDaemonSession(sessionId);
        if (!restored) {
          toast.warning(t("terminal.backgroundTasks.restoreFailed"));
          return;
        }
        await focusMainWindow();
      } catch (err) {
        logWarn("Failed to activate background session from hook", { sessionId, err });
      }
    };
    const unlisten = listen<string>("background-task-activate-requested", (event) => {
      void activate(event.payload);
    });
    const timer = window.setInterval(() => {
      if (!startupBaseReady) return;
      window.clearInterval(timer);
      void invoke<string | null>("take_pending_background_session").then((sessionId) => {
        if (sessionId) void activate(sessionId);
      });
    }, 100);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void unlisten.then((fn) => fn());
    };
  }, [t]);

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
    let cancelled = false;
    const init = async () => {
      setInitError(null);
      setStartupReady(false);
      startupBaseReady = false;

      const runStartupStage = async (stage: StartupStage, action: () => Promise<void>) => {
        if (!cancelled) setStartupStage(stage);
        const startedAt = performance.now();
        let timedOut = false;
        const timeoutId = window.setTimeout(() => {
          timedOut = true;
          logWarn("Application startup stage timed out", { stage, timeoutMs: STARTUP_STAGE_TIMEOUT_MS });
          if (!cancelled) setInitError(`startup_timeout:${stage}`);
        }, STARTUP_STAGE_TIMEOUT_MS);
        try {
          await action();
        } finally {
          window.clearTimeout(timeoutId);
          const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
          logInfo("Application startup stage completed", { stage, durationMs, timedOut });
          if (timedOut && !cancelled) setInitError(null);
        }
      };

      // 1. Tauri Store 初始化串行执行，避免插件在启动期发生并发读写竞态。
      await runStartupStage("settings", loadSettings);

      await runStartupStage("stores", async () => {
        await useSessionStore.getState().load().catch((err) => {
          logWarn("Failed to load persisted sessions during startup", err);
        });
        await useSyncStore.getState().load().catch((err) => {
          logWarn("Failed to load sync store during startup", err);
        });
      });

      void useModelPricingStore.getState().load().catch((err) => {
        logWarn("Failed to preload model pricing", err);
      });

      // 2. 加载项目列表与 worktree 记录
      await runStartupStage("projects", async () => {
        await useProjectStore.getState().fetchAll("startup");
        await useWorktreeStore.getState().loadWorktrees();
        await useWorktreeStore.getState().markMissingWorktrees();
      });

      // 3. 恢复功能关闭时清理当前环境快照；开启时检测遗留标签并询问是否恢复。
      //    注意：此处不再无条件 clear()。原 clear 的初衷是"防止重建 PTY 并重跑 startupCmd"，
      //    但 Issue #123 的需求方已明确接受"恢复时重跑 startupCmd 换取无缝手感"这一取舍，故改为问询式恢复。
      const persistedSessions = useSessionStore.getState().sessions;
      const terminalSessionRestoreEnabled = useSettingsStore.getState().terminalSessionRestoreEnabled;
      const hasRestorable = persistedSessions.some(
        (session) => (session.kind ?? "pty") === "pty"
      );
      if (!terminalSessionRestoreEnabled) {
        await useSessionStore.getState().clear().catch((err) => {
          logWarn("Failed to clear disabled terminal session restore snapshot", err);
        });
      } else if (!hasRestorable) {
        await useSessionStore.getState().clear().catch((err) => {
          logWarn("Failed to clear restored sessions during startup", err);
        });
      }

      startupBaseReady = true;
      if (!cancelled) {
        setStartupReady(true);
        setStartupStage("projects");
        runDeferredStartupTasks(startupOpenSettingsRef.current);
      }
    };

    // Let StrictMode run its setup/cleanup probe before starting non-cancellable store I/O.
    const startupTimer = window.setTimeout(() => {
      void init().catch((err) => {
        const message = err instanceof Error ? err.stack || err.message : String(err);
        logWarn("Application init failed", err);
        if (!cancelled) {
          setInitError(message);
        }
        toast.error(startupTranslateRef.current("notifications.app.initFailed"), { description: String(err) });
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(startupTimer);
    };
  }, [loadSettings]);

  const handleConfirmRestoreSessions = useCallback(() => {
    setRestorePromptOpen(false);
  }, []);

  // 用户确认恢复上次会话：重建全部标签 + attach 新 PTY，按会话类型分流（CLI 会话走原生 resume，普通 shell 贴回历史画面）。
  // 用户拒绝恢复：清除本次工作区恢复快照（不动 session_meta / 历史记录），避免下次继续询问同一批旧标签。
  const handleRejectRestoreSessions = useCallback(() => {
    setRestorePromptOpen(false);
    void useSessionStore.getState().clear().catch((err) => {
      logWarn("Failed to clear restored sessions after user rejected restore", err);
    });
    // Phase 2：拒绝恢复 = 不要这批旧标签。daemon 中对应会话若还在跑，
    // 必须一并关闭，否则成为无人认领的后台任务且阻止 daemon 空闲自灭。
    void terminalProcessManager.closeAll().catch((err) => {
      logWarn("Failed to close daemon sessions after user rejected restore", err);
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    document.documentElement.setAttribute("data-light-palette", lightThemePalette);
    document.documentElement.setAttribute("data-dark-palette", darkThemePalette);
    document.documentElement.setAttribute("lang", language);
  }, [resolvedTheme, lightThemePalette, darkThemePalette, language]);

  useEffect(() => {
    const root = document.documentElement.style;
    const terminalTheme = getTerminalTheme(
      terminalThemeName,
      resolvedTheme,
      lightThemePalette,
      darkThemePalette
    );
    const terminalThemeBackground =
      terminalTheme.background ?? (resolvedTheme === "dark" ? "#0c0e10" : "#ffffff");
    const terminalThemeForeground =
      terminalTheme.foreground ?? (resolvedTheme === "dark" ? "#f8fafc" : "#1e293b");
    const terminalThemeAccent =
      terminalTheme.blue ?? terminalTheme.cursor ?? terminalThemeForeground;
    const terminalThemeMuted =
      terminalTheme.brightBlack ?? terminalTheme.white ?? terminalThemeForeground;
    const terminalThemeSelection =
      terminalTheme.selectionBackground ?? terminalThemeAccent;
    const terminalPanelSemanticColors =
      TERMINAL_PANEL_SEMANTIC_COLORS[isLightTerminalTheme(terminalTheme) ? "light" : "dark"];

    root.setProperty("--terminal-theme-background", terminalThemeBackground);
    root.setProperty("--terminal-theme-foreground", terminalThemeForeground);
    root.setProperty("--terminal-theme-muted", terminalThemeMuted);
    root.setProperty("--terminal-theme-accent", terminalThemeAccent);
    root.setProperty("--terminal-theme-selection", terminalThemeSelection);
    root.setProperty("--term-panel-bg", "var(--terminal-theme-background, #0c0e10)");
    root.setProperty(
      "--term-panel-card",
      "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 91%, var(--term-panel-fg, #ececec) 9%)"
    );
    root.setProperty(
      "--term-panel-card-inner",
      "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 87%, var(--term-panel-fg, #ececec) 13%)"
    );
    root.setProperty(
      "--term-panel-border",
      "color-mix(in srgb, var(--term-panel-fg, #ececec) 14%, transparent)"
    );
    root.setProperty("--term-panel-fg", terminalPanelSemanticColors.fg);
    root.setProperty("--term-panel-dim", terminalPanelSemanticColors.dim);
    root.setProperty("--term-panel-green", terminalPanelSemanticColors.green);
    root.setProperty("--term-panel-yellow", terminalPanelSemanticColors.yellow);
    root.setProperty("--term-panel-red", terminalPanelSemanticColors.red);
    root.setProperty("--term-panel-magenta", terminalPanelSemanticColors.magenta);
    root.setProperty("--term-panel-cyan", terminalPanelSemanticColors.cyan);
    root.setProperty("--term-panel-blue", terminalPanelSemanticColors.blue);
    root.setProperty(
      "--term-panel-track",
      "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 94%, var(--term-panel-fg, #ececec) 6%)"
    );
  }, [
    darkThemePalette,
    lightThemePalette,
    resolvedTheme,
    terminalThemeName,
  ]);

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
    const effectiveUiFontFamily = normalizeFontFamilyStack(uiFontFamily);
    if (uiFontFamily) {
      document.documentElement.style.setProperty("--font-ui-sans", effectiveUiFontFamily);
      document.documentElement.style.setProperty("--font-ui-mono", effectiveUiFontFamily);
      document.documentElement.style.fontFamily = effectiveUiFontFamily;
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
          font-family: ${effectiveUiFontFamily} !important;
        }
        .xterm, .xterm *, .xterm-helper-textarea {
          font-family: var(--terminal-font-family, "Cascadia Code", Consolas, monospace) !important;
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

  const exitApp = useCallback(async (source: string): Promise<boolean> => {
    logInfo("exit: terminating app", { source });
    try {
      await invoke("app_exit");
      return true;
    } catch (err) {
      logWarn(`Failed to exit application from ${source}`, err);
      return false;
    }
  }, []);

  const getExitRunningTaskIds = useCallback(async (source: string) => {
    const terminalState = useTerminalStore.getState();
    const includeFinished = useSettingsStore.getState().backgroundIncludeFinishedTasks;
    // Issue #142：开关开启时，运行完毕/失败的 CLI 会话也参与退出拦截与转入后台。
    const foregroundRunningIds = terminalState.getExitTaskSessionIds(includeFinished);
    const foregroundSessionIds = new Set(terminalState.sessions.map((session) => session.id));
    let daemonAliveIds: string[] = [];
    let daemonFinishedIds: string[] = [];
    let daemonSessionsChecked = false;
    try {
      const daemonSessions = await invoke<DaemonSessionMeta[]>("pty_daemon_sessions");
      daemonSessionsChecked = true;
      daemonAliveIds = daemonSessions
        .filter((session) => (
          session.alive
          && !foregroundSessionIds.has(session.sessionId)
          && shouldIncludeDaemonExitTask(session, includeFinished)
        ))
        .map((session) => session.sessionId);
      // 后台已完成但仍可回放的 daemon 会话：仅在开关开启时纳入（避免默认退出被已完成任务打扰）
      if (includeFinished) {
        daemonFinishedIds = daemonSessions
          .filter((session) => {
            if (foregroundSessionIds.has(session.sessionId)) return false;
            if (session.alive) return false;
            return shouldIncludeDaemonExitTask(session, true);
          })
          .map((session) => session.sessionId);
      }
      logInfo("exit: daemon sessions checked", {
        source,
        includeFinished,
        foregroundRunningCount: foregroundRunningIds.length,
        backgroundDaemonAliveCount: daemonAliveIds.length,
        backgroundDaemonFinishedCount: daemonFinishedIds.length,
        daemonSessionCount: daemonSessions.length,
      });
    } catch (err) {
      logWarn("exit: failed to query daemon sessions", { source, err });
    }
    return {
      runningIds: Array.from(new Set([...foregroundRunningIds, ...daemonAliveIds, ...daemonFinishedIds])),
      daemonSessionsChecked,
    };
  }, []);

  const runExitCleanup = useCallback(async (
    source: string,
    options?: { closePty?: boolean; discardSessions?: boolean; closeAllPty?: boolean }
  ) => {
    const closePty = options?.closePty ?? true;
    const discardSessions = options?.discardSessions ?? false;
    const closeAllPty = options?.closeAllPty ?? true;
    const ptySessionIds = useTerminalStore
      .getState()
      .sessions
      .filter((session) => (session.kind ?? "pty") === "pty")
      .map((session) => session.id);
    logInfo("exit: cleanup started", {
      source,
      closePty,
      discardSessions,
      ptySessionCount: ptySessionIds.length,
      ptySessionIds,
    });
    let canExit = false;
    try {
      // 全程保持窗口可见并显示进度遮罩；destroy 前不复位 exitPhase。
      flushSync(() => {
        setExitNotice(null);
        setExitPhase("syncing");
      });
      await runCloseAutoSync();
      setExitPhase("closing");
      // Issue #123：正常退出前把各终端最终画面强制落盘，供下次启动问询式恢复。
      // 必须在 PtyHost closeAll 之前，避免关闭 PTY 触发的重绘/清屏影响 serialize 结果；
      // 此处不再 clear() 工作区快照——那会让"关闭后恢复"永远拿不到数据。
      if (!discardSessions) {
        await flushTerminalSnapshotsNow();
      }
      // Phase 2：daemon 模式"转入后台"时 closePty=false——PTY 留在守护进程里继续跑，
      // 快照仍落盘作为 daemon 也挂掉时的最终兜底。
      const terminalCleanup = await cleanupTerminalProcessesForExit(
        { closePty, closeAllPty, foregroundSessionIds: ptySessionIds },
        {
          closeAll: () => terminalProcessManager.closeAll(),
          close: (sessionId) => terminalProcessManager.close(sessionId),
          shutdownDaemonIfIdle: () => invoke<boolean>("pty_daemon_shutdown_if_idle"),
        },
      );
      if (terminalCleanup.closeAllError) {
        logWarn("Failed to close all PTY sessions before exit", {
          source,
          err: terminalCleanup.closeAllError,
        });
      }
      for (const failure of terminalCleanup.foregroundCloseErrors) {
        logWarn("Failed to close foreground PTY session before exit", {
          source,
          sessionId: failure.sessionId,
          err: failure.error,
        });
      }
      if (closePty) {
        logInfo("exit: PTY cleanup completed", {
          source,
          closeAllPty,
          requestedCount: ptySessionIds.length,
          failedForegroundCount: terminalCleanup.foregroundCloseErrors.length,
          daemonStopped: terminalCleanup.daemonStopped,
        });
      }
      if (!terminalCleanup.canExit) {
        logWarn("exit: daemon shutdown failed, keeping application open", {
          source,
          err: terminalCleanup.shutdownError,
        });
        return;
      }
      if (discardSessions) {
        await useSessionStore.getState().clear().catch((err) => {
          logWarn("Failed to clear discarded terminal sessions", err);
        });
        logInfo("exit: persisted sessions discarded", { source });
      }
      canExit = true;
    } catch (err) {
      logWarn("exit: cleanup failed, keeping application open", { source, err });
    } finally {
      logInfo("exit: cleanup finished", { source, closePty, discardSessions, canExit });
      if (canExit && await exitApp(source)) return;
      flushSync(() => {
        setExitPhase(null);
        setExitNotice(null);
      });
    }
  }, [exitApp, runCloseAutoSync]);

  // Issue #123 Phase 1/2：转入后台。
  // daemon 可用 → 真退出应用，任务由守护进程续跑（下次启动 attach 回放）；
  // daemon 不可用 → 托盘常驻降级：仅隐藏窗口，严禁触碰退出链路
  // （runExitCleanup / PtyHost closeAll）——PTY、hook server、快照节流全部存活。
  const minimizeToTray = useCallback(async () => {
    try {
      await getCurrentWindow().hide();
      backgroundTaskModeActive = true;
    } catch (err) {
      logWarn("Failed to hide window for tray mode", err);
    }
  }, []);

  const enterBackgroundTaskMode = useCallback(async () => {
    let daemonActive = false;
    try {
      daemonActive = await invoke<boolean>("pty_daemon_active");
    } catch (err) {
      logWarn("Failed to query pty daemon state", err);
    }
    logInfo("exit: background task mode requested", { daemonActive });
    if (daemonActive) {
      await runExitCleanup("background daemon", { closePty: false });
      return;
    }
    try {
      await minimizeToTray();
      return;
    } catch (err) {
      // hide 失败时保持窗口可见即可，绝不能误走退出链路杀任务。
      logWarn("Failed to hide window for background task mode", err);
    }
  }, [minimizeToTray, runExitCleanup]);

  // 所有"退出应用"入口（closeBehavior=exit、关闭弹窗选退出、托盘退出）必须经此守卫：
  // 无运行中任务且 daemon 查询成功 → 清理全部空闲 PTY 后退出；有任务 → 按设置分流。
  // daemon 查询失败 → 仅关闭前台 PTY，不能以“未知”等同“无后台任务”。
  const requestExitGuardedByRunningTasks = useCallback(async (source: string) => {
    const { runningIds, daemonSessionsChecked } = await getExitRunningTaskIds(source);
    logInfo("exit: guarded request evaluated", {
      source,
      runningCount: runningIds.length,
      runningIds,
      daemonSessionsChecked,
      behavior: exitTasksBehaviorRef.current,
    });
    if (runningIds.length === 0) {
      await runExitCleanup(source, { closeAllPty: daemonSessionsChecked });
      return;
    }
    const behavior = exitTasksBehaviorRef.current;
    if (behavior === "background") {
      await enterBackgroundTaskMode();
      return;
    }
    if (behavior === "minimize") {
      await minimizeToTray();
      return;
    }
    if (behavior === "discard") {
      await runExitCleanup(source, {
        discardSessions: true,
        closeAllPty: daemonSessionsChecked,
      });
      return;
    }
    pendingExitSourceRef.current = source;
    pendingExitDaemonSessionsCheckedRef.current = daemonSessionsChecked;
    setRunningTasksCount(runningIds.length);
    // 托盘退出时窗口可能处于隐藏态，弹窗前必须先恢复窗口。
    await focusMainWindow();
    setRunningTasksDialogOpen(true);
  }, [enterBackgroundTaskMode, getExitRunningTaskIds, minimizeToTray, runExitCleanup]);

  const handleRunningTasksDialogBackground = useCallback((remember: boolean) => {
    setRunningTasksDialogOpen(false);
    logInfo("exit: running task dialog selected background", {
      source: pendingExitSourceRef.current,
      remember,
      runningCount: runningTasksCount,
    });
    if (remember) {
      void updateSetting("exitWithRunningTasksBehavior", "background");
    }
    void enterBackgroundTaskMode();
  }, [enterBackgroundTaskMode, runningTasksCount, updateSetting]);

  const handleRunningTasksDialogMinimize = useCallback((remember: boolean) => {
    setRunningTasksDialogOpen(false);
    logInfo("exit: running task dialog selected minimize", {
      source: pendingExitSourceRef.current,
      remember,
      runningCount: runningTasksCount,
    });
    if (remember) {
      void updateSetting("exitWithRunningTasksBehavior", "minimize");
    }
    void minimizeToTray();
  }, [minimizeToTray, runningTasksCount, updateSetting]);

  const handleRunningTasksDialogDiscard = useCallback((remember: boolean) => {
    setRunningTasksDialogOpen(false);
    logInfo("exit: running task dialog selected discard", {
      source: pendingExitSourceRef.current,
      remember,
      runningCount: runningTasksCount,
    });
    if (remember) {
      void updateSetting("exitWithRunningTasksBehavior", "discard");
    }
    void runExitCleanup(pendingExitSourceRef.current, {
      discardSessions: true,
      closeAllPty: pendingExitDaemonSessionsCheckedRef.current,
    });
  }, [runExitCleanup, runningTasksCount, updateSetting]);

  // 窗口重新获得焦点（托盘左键 / 通知点击唤回）即退出后台任务模式。
  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) backgroundTaskModeActive = false;
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenPromise = listen("tray-quit-requested", async () => {
      await requestExitGuardedByRunningTasks("tray quit");
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [requestExitGuardedByRunningTasks]);

  // 关闭窗口拦截：根据 closeBehavior 决定最小化到托盘 / 直接退出 / 弹窗询问
  useEffect(() => {
    if (!IN_TAURI) return;
    const appWindow = getCurrentWindow();
    let unlistenPromise: Promise<() => void> | null = null;

    unlistenPromise = appWindow.onCloseRequested(async (event) => {
      const behavior = closeBehaviorRef.current;
      logInfo("exit: window close requested", { behavior });
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
        await requestExitGuardedByRunningTasks("window close");
        return;
      }
      event.preventDefault();
      const { runningIds, daemonSessionsChecked } = await getExitRunningTaskIds("window close");
      logInfo("exit: close ask evaluated", {
        runningCount: runningIds.length,
        runningIds,
      });
      if (runningIds.length > 0) {
        pendingExitSourceRef.current = "window close";
        pendingExitDaemonSessionsCheckedRef.current = daemonSessionsChecked;
        setRunningTasksCount(runningIds.length);
        setRunningTasksDialogOpen(true);
      } else {
        setCloseDialogOpen(true);
      }
    });

    return () => {
      unlistenPromise?.then((fn) => fn()).catch(() => {});
    };
  }, [getExitRunningTaskIds, requestExitGuardedByRunningTasks]);

  const handleCloseDialogMinimize = useCallback(
    (remember: boolean) => {
      setCloseDialogOpen(false);
      if (remember) {
        void updateSetting("closeBehavior", "minimize");
      }
      void minimizeToTray();
    },
    [minimizeToTray, updateSetting]
  );

  const handleCloseDialogExit = useCallback(
    (remember: boolean) => {
      setCloseDialogOpen(false);
      if (remember) {
        void updateSetting("closeBehavior", "exit");
      }
      void (async () => {
        await requestExitGuardedByRunningTasks("close dialog");
      })();
    },
    [requestExitGuardedByRunningTasks, updateSetting]
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
        if (settingsWindowExpanded) {
          await appWindow.setMinSize(new LogicalSize(800, WINDOW_MIN_HEIGHT));
          const targetWidth = Math.max(restoreWindowWidthRef.current ?? 800, 800);
          await appWindow.setSize(
            new LogicalSize(targetWidth, Math.max(window.innerHeight, WINDOW_MIN_HEIGHT))
          );
          return;
        }
        // Closing settings in compact mode used to force an immediate native window shrink,
        // which caused a visible flash on some platforms. Restore the smaller min width but
        // keep the current width until the user resizes or changes view mode.
        await appWindow.setMinSize(new LogicalSize(COMPACT_WINDOW_WIDTH, WINDOW_MIN_HEIGHT));
      } catch (err) {
        logWarn("Failed to adjust window size", err);
      }
    })();
  }, [isMacOs, viewMode, settingsWindowExpanded]);

  useEffect(() => {
    if (!settingsLoaded || !startupReady || firstScreenPerfReported) return;
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
  }, [handleOpenSettings, resolvedTheme, settingsLoaded, startupReady, viewMode]);

  if (initError) {
    return (
      <AppFailureState
        title={t("app.init.failedTitle")}
        description={t("app.init.failedDescription")}
        detail={initError}
        primaryAction={{
          label: t("common.retry"),
          onClick: () => window.location.reload(),
        }}
      />
    );
  }

  if (!settingsLoaded || !startupReady) {
    const stageLabel = startupStage === "settings"
      ? t("app.init.loadingSettings")
      : startupStage === "stores"
        ? t("app.init.loadingStores")
        : t("app.init.loadingProjects");
    return (
      <div className="ui-workspace-shell flex h-screen items-center justify-center px-6" role="status" aria-live="polite">
        <div className="flex max-w-sm items-center gap-3 text-on-surface-variant">
          <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true" />
          <div>
            <div className="text-sm font-medium text-on-surface">{t("app.init.loading")}</div>
            <div className="mt-1 text-xs text-text-muted">{stageLabel}</div>
          </div>
        </div>
      </div>
    );
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
            projectScopedTerminalViewEnabled={projectScopedTerminalViewEnabled}
            terminalScope={terminalScope}
            onTerminalScopeChange={setTerminalScope}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!terminalFullscreen && (
            <Sidebar
              onOpenSettings={handleOpenSettings}
              onOpenStats={handleOpenStats}
              projectScopedTerminalViewEnabled={projectScopedTerminalViewEnabled}
              terminalScope={terminalScope}
              onTerminalScopeChange={setTerminalScope}
            />
          )}
          <main id="main-content" className="ui-main-shell flex min-w-0 flex-1 flex-col" tabIndex={-1}>
            <TerminalTabs
              fullscreen={terminalFullscreen}
              onToggleFullscreen={handleToggleTerminalFullscreen}
              projectScopedTerminalViewEnabled={projectScopedTerminalViewEnabled}
              terminalScope={terminalScope}
            />
          </main>
        </div>
      )}
      <CommandPalette />
      <ExternalSessionSyncDialog />
      <Suspense fallback={null}>
        {settingsEverOpened && (
            <SettingsModal
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
            onAfterClose={() => {
              setSettingsWindowExpanded(false);
            }}
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
      <RunningTasksExitDialog
        open={runningTasksDialogOpen}
        runningCount={runningTasksCount}
        onBackground={handleRunningTasksDialogBackground}
        onMinimize={handleRunningTasksDialogMinimize}
        onDiscard={handleRunningTasksDialogDiscard}
        onClose={() => setRunningTasksDialogOpen(false)}
      />
      <ConfirmDialog
        open={restorePromptOpen}
        title="恢复上次会话"
        message="检测到上次遗留的终端标签。是否恢复这些标签（CLI 会话继续上次对话，普通终端贴回历史画面）？"
        confirmText="恢复"
        cancelText="不恢复"
        onConfirm={handleConfirmRestoreSessions}
        onClose={handleRejectRestoreSessions}
      />
      {exitPhase && <ExitProgressOverlay phase={exitPhase} notice={exitNotice} />}
      <Toaster
        theme={resolvedTheme}
        position="bottom-right"
        closeButton
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
