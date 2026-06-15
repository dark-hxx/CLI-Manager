import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { TerminalSession, Project } from "../lib/types";
import { logError, logInfo } from "../lib/logger";
import { useSettingsStore } from "./settingsStore";
import { useSessionStore } from "./sessionStore";
import { normalizeShellKey } from "../lib/shell";
import {
  addSessionToPaneTree,
  collectPaneLeaves,
  createSinglePaneTree,
  findFirstSessionId,
  findPaneLeaf,
  findPaneLeafBySession,
  getNextSessionIdForShortcut as resolveNextSessionIdForShortcut,
  moveSessionToPane as moveSessionToPaneTree,
  removeSessionFromPaneTree,
  reorderSessionInPane,
  resizePaneSplit,
  setPaneActiveSession,
  splitPaneLeaf,
  splitExistingSessionToPaneEdge,
  unsplitPaneLeaf,
  type TerminalPaneDropEdge,
  type TerminalPaneNode,
  type TerminalPaneSplitDirection,
} from "./terminalPaneTree";

export type SessionStatus = "running" | "exited" | "error";
export type CliHookSource = "claude" | "codex";
export type CliHookEventName = "UserPromptSubmit" | "Notification" | "Stop" | "StopFailure" | "PermissionRequest";
export type TabNotificationState = "none" | "running" | "attention" | "done" | "failed";
export type ShellRuntimeEventName = "command_started" | "command_finished" | "prompt_shown";

type TabStatusSourceName = "hook" | "shell";

interface TabStatusSources {
  hook?: TabNotificationState;
  shell?: TabNotificationState;
  hookUpdatedAt?: string;
  shellUpdatedAt?: string;
}

export interface TabStatusDetails {
  status: TabNotificationState;
  updatedAt: string | null;
}

export interface ShellRuntimePayload {
  sessionId: string;
  event: ShellRuntimeEventName;
  exitCode?: number | null;
  timestamp?: string | null;
  /** osc = shell integration 序列驱动（可信）；input = 前端回车猜测（仅 cmd 接受） */
  origin?: "osc" | "input";
}

const SHELL_RUNTIME_MONITORING_ENV = "CLI_MANAGER_SHELL_RUNTIME_MONITORING";
const TAB_STATUS_PRIORITY: Record<TabNotificationState, number> = {
  none: 0,
  done: 1,
  running: 2,
  failed: 3,
  attention: 4,
};

export interface CliHookPayload {
  tabId: string;
  source?: CliHookSource | null;
  event: CliHookEventName;
  title?: string | null;
  message?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  timestamp?: string | null;
}

export interface SplitState {
  direction: "horizontal" | "vertical";
  secondSessionId: string;
  ratio: number;
}

export interface SplitTerminalOptions {
  projectId?: string;
  cwd?: string;
  title?: string;
  startupCmd?: string;
  envVars?: Record<string, string>;
  shell?: string;
}

interface HookToolStatus {
  status: "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";
}

interface HookSettingsStatusPayload {
  claude: HookToolStatus;
  codex: HookToolStatus;
}

interface PtyStatusPayload {
  status: string;
  exit_code: number | null;
}

interface TerminalStore {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  paneTree: TerminalPaneNode | null;
  activePaneId: string | null;
  sessionStatuses: Record<string, SessionStatus>;
  statusListeners: Record<string, UnlistenFn>;
  tabNotifications: Record<string, TabNotificationState>;
  tabStatuses: Record<string, TabStatusSources>;
  tabStatusDetails: Record<string, TabStatusDetails>;
  splits: Record<string, SplitState>;
  hiddenBackgroundSessionIds: Set<string>;
  createSession: (projectId?: string, cwd?: string, title?: string, startupCmd?: string, envVars?: Record<string, string>, shell?: string) => Promise<string>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  markAttentionInputHandled: (sessionId: string) => void;
  handleCliHookEvent: (payload: CliHookPayload) => string | null;
  handleShellRuntimeEvent: (payload: ShellRuntimePayload) => string | null;
  reorderSessions: (fromId: string, toId: string) => void;
  moveSessionToPane: (sessionId: string, targetPaneId: string, beforeSessionId?: string) => void;
  splitSessionToPaneEdge: (sessionId: string, targetPaneId: string, edge: TerminalPaneDropEdge) => void;
  renameSession: (id: string, title: string) => void;
  splitTerminal: (sessionId: string, direction: TerminalPaneSplitDirection, options?: SplitTerminalOptions) => Promise<string | null>;
  unsplitTerminal: (sessionId: string) => Promise<void>;
  setSplitRatio: (splitId: string, ratio: number) => void;
  getNextSessionIdForShortcut: (delta: 1 | -1) => string | null;
  restoreSessions: (projectMap: Map<string, Project>, projectHealth: Record<string, boolean>) => Promise<void>;
  hideBackgroundForSession: (sessionId: string) => void;
  showBackgroundForSession: (sessionId: string) => void;
}

// 防止 StrictMode 双重调用
let restoreInProgress = false;

// setActive 防抖：高频切换标签时合并持久化写入
let saveActiveIdTimer: ReturnType<typeof setTimeout> | null = null;
let paneIdSeq = 0;

function createPaneId() {
  paneIdSeq += 1;
  return `pane-${Date.now().toString(36)}-${paneIdSeq.toString(36)}`;
}

function createSplitSessionTitle(options?: SplitTerminalOptions) {
  return options?.title ?? "Split Terminal";
}

function scheduleSaveActiveId(id: string | null) {
  if (saveActiveIdTimer !== null) clearTimeout(saveActiveIdTimer);
  saveActiveIdTimer = setTimeout(() => {
    saveActiveIdTimer = null;
    useSessionStore.getState().saveActiveSessionId(id).catch(() => {});
  }, 200);
}

function summarizeStartupCmd(startupCmd?: string): string | null {
  if (!startupCmd) return null;
  const redacted = startupCmd
    .replace(/((?:token|password|passwd|secret|api[_-]?key)\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/(--(?:token|password|passwd|secret|api[_-]?key)\s+)(\S+)/gi, "$1<redacted>");
  const summary = redacted.replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 120)}...` : summary;
}

function logTerminalExitStatus(session: TerminalSession, payload: PtyStatusPayload) {
  if (payload.status !== "exited" && payload.status !== "error") return;
  logInfo("pty status received", {
    sessionId: session.id,
    title: session.title,
    projectId: session.projectId ?? null,
    cwd: session.cwd ?? null,
    shell: session.shell ?? null,
    hasStartupCmd: Boolean(session.startupCmd),
    startupCmdSummary: summarizeStartupCmd(session.startupCmd),
    status: payload.status,
    exit_code: payload.exit_code,
  });
}

function mapCliHookEvent(event: CliHookEventName): TabNotificationState | null {
  if (event === "UserPromptSubmit") return "running";
  // Notification 经 settings.json matcher 过滤，只有 permission_prompt /
  // idle_prompt（需要用户介入）会送达
  if (event === "Notification") return "attention";
  if (event === "PermissionRequest") return "attention";
  if (event === "StopFailure") return "failed";
  if (event === "Stop") return "done";
  return null;
}

function mapShellRuntimeEvent(event: ShellRuntimeEventName, exitCode?: number | null): TabNotificationState {
  if (event === "command_started") return "running";
  if (event === "command_finished") {
    if (exitCode === 0) return "done";
    return typeof exitCode === "number" && Number.isFinite(exitCode) ? "failed" : "none";
  }
  return "none";
}

function resolvePrimaryTabId(tabId: string, splits: Record<string, SplitState>): string {
  for (const [primaryId, split] of Object.entries(splits)) {
    if (split.secondSessionId === tabId) return primaryId;
  }
  return tabId;
}

function getTabStatusEntry(state: TabStatusSources | undefined): TabNotificationState {
  if (!state) return "none";
  const candidates: TabNotificationState[] = [state.hook ?? "none", state.shell ?? "none"];
  return candidates.reduce((current, next) => (TAB_STATUS_PRIORITY[next] > TAB_STATUS_PRIORITY[current] ? next : current), "none");
}

function getTabStatusDetails(state: TabStatusSources | undefined): TabStatusDetails {
  if (!state) return { status: "none", updatedAt: null };
  const hookScore = state.hook ? TAB_STATUS_PRIORITY[state.hook] : -1;
  const shellScore = state.shell ? TAB_STATUS_PRIORITY[state.shell] : -1;
  if (hookScore >= shellScore) {
    return { status: state.hook ?? "none", updatedAt: state.hookUpdatedAt ?? null };
  }
  return { status: state.shell ?? "none", updatedAt: state.shellUpdatedAt ?? null };
}

function buildTabStatusUpdate(
  state: Pick<TerminalStore, "tabStatuses" | "tabNotifications" | "tabStatusDetails">,
  sessionId: string,
  source: TabStatusSourceName,
  status: TabNotificationState,
  updatedAt: string
): Pick<TerminalStore, "tabStatuses" | "tabNotifications" | "tabStatusDetails"> {
  const previous = state.tabStatuses[sessionId] ?? {};
  const next: TabStatusSources = {
    ...previous,
    [source]: status,
    [source === "hook" ? "hookUpdatedAt" : "shellUpdatedAt"]: updatedAt,
  };
  return {
    tabStatuses: {
      ...state.tabStatuses,
      [sessionId]: next,
    },
    tabNotifications: {
      ...state.tabNotifications,
      [sessionId]: getTabStatusEntry(next),
    },
    tabStatusDetails: {
      ...state.tabStatusDetails,
      [sessionId]: getTabStatusDetails(next),
    },
  };
}

// Shell 注入支持：这些 shell 由 pty/manager.rs 注入 shell integration
// （powershell/pwsh：prompt 函数；gitbash：rcfile；cmd：PROMPT 环境变量）。
// bash（System32 WSL 启动器）与 wsl 无法可靠注入，不在此列。
// 事件接受不按 shell 过滤——任何 shell 里用户自带的 OSC 133/633 集成
// （oh-my-posh、VS Code shell integration 等）同样可信。
function supportsShellRuntimeInjection(shell?: string | null): boolean {
  const normalized = normalizeShellKey(shell);
  return (
    normalized === undefined ||
    normalized === "powershell" ||
    normalized === "pwsh" ||
    normalized === "cmd" ||
    normalized === "gitbash"
  );
}

function isShellRuntimeMonitoringEnabled(): boolean {
  return useSettingsStore.getState().shellRuntimeMonitoringEnabled;
}

// hook running 超时回退：Stop/StopFailure 丢失（hook 脚本失败、bridge 不可达）
// 时 Tab 会永久停留 running，超时后回退为 none（未知）。阈值取宽（Claude 长任务
// 可合法运行很久），只兜底明显异常的滞留。
const HOOK_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;
const hookRunningTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function clearHookRunningTimeout(tabId: string) {
  const timer = hookRunningTimeouts.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  hookRunningTimeouts.delete(tabId);
}

function scheduleHookRunningTimeout(tabId: string, updatedAt: string) {
  clearHookRunningTimeout(tabId);
  const timer = setTimeout(() => {
    hookRunningTimeouts.delete(tabId);
    const store = useTerminalStore.getState();
    if (!store.sessions.some((session) => session.id === tabId)) return;
    const current = store.tabStatuses[tabId];
    if (current?.hook !== "running" || current.hookUpdatedAt !== updatedAt) return;
    useTerminalStore.setState((state) => buildTabStatusUpdate(state, tabId, "hook", "none", new Date().toISOString()));
  }, HOOK_RUNNING_TIMEOUT_MS);
  hookRunningTimeouts.set(tabId, timer);
}

function detectCliHookTool(title?: string | null, startupCmd?: string | null): CliHookSource | null {
  const raw = `${title ?? ""} ${startupCmd ?? ""}`.toLowerCase();
  if (/(^|[\s("'])codex([\s)"']|$)/.test(raw)) return "codex";
  if (/(^|[\s("'])claude([\s)"']|$)/.test(raw)) return "claude";
  return null;
}

async function shouldEnableHookEnv(title?: string | null, startupCmd?: string | null): Promise<boolean> {
  const tool = detectCliHookTool(title, startupCmd);
  if (!tool) return false;
  const settings = useSettingsStore.getState();
  try {
    const status = await invoke<HookSettingsStatusPayload>("hook_settings_get_status", {
      selectedDir: settings.claudeHookConfigDir?.trim() || null,
      codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
    });
    return status[tool]?.status === "installed";
  } catch (err) {
    logError("hook_settings_get_status failed while deciding terminal hook env", { tool, err });
    return false;
  }
}

function buildPtyEnvVars(envVars?: Record<string, string> | null, shell?: string | null): Record<string, string> | null {
  const next = { ...(envVars ?? {}) };
  if (isShellRuntimeMonitoringEnabled() && supportsShellRuntimeInjection(shell)) {
    next[SHELL_RUNTIME_MONITORING_ENV] = "1";
  } else {
    delete next[SHELL_RUNTIME_MONITORING_ENV];
  }
  return Object.keys(next).length > 0 ? next : null;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  paneTree: null,
  activePaneId: null,
  sessionStatuses: {},
  statusListeners: {},
  tabNotifications: {},
  tabStatuses: {},
  tabStatusDetails: {},
  splits: {},
  hiddenBackgroundSessionIds: new Set<string>(),

  createSession: async (projectId, cwd, title, startupCmd, envVars, shell) => {
    const normalizedInputShell = normalizeShellKey(shell);
    const normalizedDefaultShell = normalizeShellKey(useSettingsStore.getState().defaultShell);
    const resolvedShell =
      normalizedInputShell ?? (projectId ? null : (normalizedDefaultShell ?? null));

    let sessionId: string;
    try {
      sessionId = await invoke<string>("pty_create", {
        cwd: cwd ?? null,
        envVars: buildPtyEnvVars(envVars ?? null, resolvedShell),
        shell: resolvedShell,
        hookEnvEnabled: await shouldEnableHookEnv(title, startupCmd),
      });
    } catch (err) {
      const description = String(err);
      toast.error("创建终端失败", { description });
      logError("pty_create invoke failed", {
        projectId: projectId ?? null,
        cwd: cwd ?? null,
        shell: resolvedShell,
        err,
      });
      throw err;
    }
    const session: TerminalSession = {
      id: sessionId,
      projectId,
      title: title ?? "Terminal",
      cwd,
      shell: resolvedShell,
      envVars,
      startupCmd,
    };

    const unlisten = await listen<PtyStatusPayload>(`pty-status-${sessionId}`, (event) => {
      const status = event.payload.status as SessionStatus;
      logTerminalExitStatus(session, event.payload);
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, [sessionId]: status },
      }));
    });

    const newSessions = [...get().sessions, session];
    const paneResult = addSessionToPaneTree(get().paneTree, get().activePaneId, sessionId, createPaneId);
    set({
      sessions: newSessions,
      activeSessionId: sessionId,
      paneTree: paneResult.tree,
      activePaneId: paneResult.activePaneId,
      sessionStatuses: { ...get().sessionStatuses, [sessionId]: "running" },
      statusListeners: { ...get().statusListeners, [sessionId]: unlisten },
    });

    // 持久化到 sessionStore
    await useSessionStore.getState().saveSessions(newSessions);
    await useSessionStore.getState().saveActiveSessionId(sessionId);

    if (startupCmd) {
      setTimeout(() => {
        invoke("pty_write", { sessionId, data: startupCmd + "\r" }).catch((err) => {
          toast.error("启动命令写入失败", { description: String(err) });
          logError("Failed to write startup command", {
            sessionId,
            hasStartupCmd: true,
            startupCmdSummary: summarizeStartupCmd(startupCmd),
            err,
          });
        });
      }, 500);
    }

    return sessionId;
  },

  closeSession: async (id) => {
    const ptySessionIds = [id];

    // 必须在 set sessions 之前记录原索引，否则后续 findIndex 永远返回 -1，
    // 导致 persistedSplits 永远清不掉（历史 bug）。
    const closedIndex = get().sessions.findIndex((s) => s.id === id);
    const remaining = get().sessions.filter((s) => s.id !== id);
    const newStatuses = { ...get().sessionStatuses };
    const newListeners = { ...get().statusListeners };
    const newNotifications = { ...get().tabNotifications };
    const newTabStatuses = { ...get().tabStatuses };
    const newTabStatusDetails = { ...get().tabStatusDetails };
    const nextPaneTree = removeSessionFromPaneTree(get().paneTree, id);
    const nextActiveId =
      get().activeSessionId === id
        ? findFirstSessionId(nextPaneTree)
        : get().activeSessionId;
    const activePane = nextActiveId ? findPaneLeafBySession(nextPaneTree, nextActiveId) : null;

    delete newStatuses[id];
    delete newListeners[id];
    delete newNotifications[id];
    delete newTabStatuses[id];
    delete newTabStatusDetails[id];

    // Drop in-memory background overrides for closed sessions (R8).
    const prevHidden = get().hiddenBackgroundSessionIds;
    let newHidden = prevHidden;
    if (prevHidden.has(id)) {
      newHidden = new Set(prevHidden);
      newHidden.delete(id);
    }

    get().statusListeners[id]?.();

    set({
      sessions: remaining,
      activeSessionId: nextActiveId,
      paneTree: nextPaneTree,
      activePaneId: activePane?.id ?? collectPaneLeaves(nextPaneTree)[0]?.id ?? null,
      sessionStatuses: newStatuses,
      statusListeners: newListeners,
      tabNotifications: newNotifications,
      tabStatuses: newTabStatuses,
      tabStatusDetails: newTabStatusDetails,
      splits: {},
      ...(newHidden !== prevHidden ? { hiddenBackgroundSessionIds: newHidden } : {}),
    });

    try {
      await useSessionStore.getState().saveSessions(remaining);
      await useSessionStore.getState().saveActiveSessionId(nextActiveId);

      // 更新 splits（移除已关闭主会话对应的 split），使用关闭前记录的索引
      if (closedIndex >= 0) {
        const persistedSplits = useSessionStore.getState().splits.filter(
          (s) => s.primarySessionIndex !== closedIndex
        );
        await useSessionStore.getState().saveSplits(persistedSplits);
      }
    } finally {
      for (const sessionId of ptySessionIds) {
        void invoke("pty_close", { sessionId }).catch((err) => {
          logError("pty_close invoke failed while closing terminal tab", { sessionId, err });
        });
      }
    }
  },

  setActive: (id) => {
    const paneResult = setPaneActiveSession(get().paneTree, id);
    set({ activeSessionId: id, paneTree: paneResult.tree, activePaneId: paneResult.activePaneId ?? get().activePaneId });
    scheduleSaveActiveId(id);
  },

  markAttentionInputHandled: (sessionId) => {
    const tabId = resolvePrimaryTabId(sessionId, get().splits);
    if (get().tabStatuses[tabId]?.hook !== "attention") return;
    const updatedAt = new Date().toISOString();
    scheduleHookRunningTimeout(tabId, updatedAt);
    set((state) => buildTabStatusUpdate(state, tabId, "hook", "running", updatedAt));
  },

  handleCliHookEvent: (payload) => {
    const rawTabId = payload.tabId;
    const tabId = resolvePrimaryTabId(payload.tabId, get().splits);
    if (!get().sessions.some((session) => session.id === tabId)) return null;
    const cliSessionId = payload.sessionId?.trim();
    if (cliSessionId && get().sessions.some((session) => session.id === rawTabId)) {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === rawTabId && session.cliSessionId !== cliSessionId
            ? { ...session, cliSessionId }
            : session
        ),
      }));
    }
    const updatedAt = payload.timestamp ?? new Date().toISOString();
    const status = mapCliHookEvent(payload.event);
    if (!status) return tabId;
    // 乱序防御：各 hook 事件由独立进程上报，到达顺序不保证；丢弃比已记录
    // 状态更旧的事件（如 Stop 之后才迟到的 UserPromptSubmit）。
    const previousAt = get().tabStatuses[tabId]?.hookUpdatedAt;
    if (previousAt) {
      const incoming = Date.parse(updatedAt);
      const existing = Date.parse(previousAt);
      if (Number.isFinite(incoming) && Number.isFinite(existing) && incoming < existing) return tabId;
    }
    if (status === "running") {
      scheduleHookRunningTimeout(tabId, updatedAt);
    } else {
      clearHookRunningTimeout(tabId);
    }
    set((state) => {
      const next = buildTabStatusUpdate(state, tabId, "hook", status, updatedAt);
      if (status !== "done" && status !== "failed") return next;

      const tabStatus = next.tabStatuses[tabId];
      if (!tabStatus?.shell) return next;
      const resolved: TabStatusSources = { ...tabStatus };
      delete resolved.shell;
      delete resolved.shellUpdatedAt;
      return {
        tabStatuses: { ...next.tabStatuses, [tabId]: resolved },
        tabNotifications: { ...next.tabNotifications, [tabId]: getTabStatusEntry(resolved) },
        tabStatusDetails: { ...next.tabStatusDetails, [tabId]: getTabStatusDetails(resolved) },
      };
    });
    return tabId;
  },

  handleShellRuntimeEvent: (payload) => {
    const tabId = resolvePrimaryTabId(payload.sessionId, get().splits);
    const session = get().sessions.find((item) => item.id === tabId);
    if (!session || !isShellRuntimeMonitoringEnabled()) return null;
    // 回车猜测只对 cmd 生效：cmd 无法注入 C 序列，输入侧猜测是它唯一的
    // command_started 信号；其余 shell 由 OSC 133/633/777 驱动，猜测只会误判
    // （多行输入、TUI 内回车、历史命令均不可靠）。
    if (payload.origin === "input" && normalizeShellKey(session.shell) !== "cmd") return null;
    const updatedAt = payload.timestamp ?? new Date().toISOString();
    if (payload.event === "prompt_shown") {
      // prompt 重新出现 = 前一条命令已结束。仅在 shell 来源仍是 running 时收口
      // 为 done，覆盖拿不到 D;exit 的场景（Ctrl+C 中断、cmd 无 exit code）。
      if (get().tabStatuses[tabId]?.shell !== "running") return tabId;
      set((state) => buildTabStatusUpdate(state, tabId, "shell", "done", updatedAt));
      return tabId;
    }
    const status = mapShellRuntimeEvent(payload.event, payload.exitCode ?? null);
    if (status === "none") return tabId;
    set((state) => buildTabStatusUpdate(state, tabId, "shell", status, updatedAt));
    return tabId;
  },

  reorderSessions: (fromId, toId) => {
    const pane = findPaneLeafBySession(get().paneTree, fromId);
    if (!pane || !pane.sessionIds.includes(toId)) return;
    const nextTree = reorderSessionInPane(get().paneTree, pane.id, fromId, toId);
    set({ paneTree: nextTree, activePaneId: pane.id, activeSessionId: fromId });
    scheduleSaveActiveId(fromId);
  },

  moveSessionToPane: (sessionId, targetPaneId, beforeSessionId) => {
    const sourcePane = findPaneLeafBySession(get().paneTree, sessionId);
    const targetPane = findPaneLeaf(get().paneTree, targetPaneId);
    if (!sourcePane || !targetPane || sourcePane.id === targetPane.id) return;
    const result = moveSessionToPaneTree(get().paneTree, sourcePane.id, targetPane.id, sessionId, beforeSessionId);
    set({ paneTree: result.tree, activePaneId: result.activePaneId, activeSessionId: sessionId });
    scheduleSaveActiveId(sessionId);
  },

  splitSessionToPaneEdge: (sessionId, targetPaneId, edge) => {
    const result = splitExistingSessionToPaneEdge(get().paneTree, sessionId, targetPaneId, edge, createPaneId);
    if (!result.changed) return;
    set({
      paneTree: result.tree,
      activePaneId: result.activePaneId,
      activeSessionId: result.activeSessionId,
      splits: {},
    });
    scheduleSaveActiveId(result.activeSessionId);
  },

  renameSession: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    let changed = false;
    const nextSessions = get().sessions.map((session) => {
      if (session.id !== id) return session;
      if (session.title === trimmed) return session;
      changed = true;
      return { ...session, title: trimmed };
    });
    if (!changed) return;
    set({ sessions: nextSessions });
    useSessionStore.getState().saveSessions(nextSessions).catch(() => {});
  },

  splitTerminal: async (sessionId, direction, options) => {
    const paneTree = get().paneTree;
    const targetPane = findPaneLeafBySession(paneTree, sessionId);
    if (!targetPane || !paneTree) return null;

    const normalizedInputShell = normalizeShellKey(options?.shell);
    const normalizedDefaultShell = normalizeShellKey(useSettingsStore.getState().defaultShell);
    const resolvedShell = normalizedInputShell ?? (options?.projectId ? null : (normalizedDefaultShell ?? null));

    let splitSessionId: string;
    try {
      splitSessionId = await invoke<string>("pty_create", {
        cwd: options?.cwd ?? null,
        envVars: buildPtyEnvVars(options?.envVars ?? null, resolvedShell),
        shell: resolvedShell,
        hookEnvEnabled: await shouldEnableHookEnv(options?.title, options?.startupCmd),
      });
    } catch (err) {
      const description = String(err);
      toast.error("创建分屏终端失败", { description });
      logError("pty_create invoke failed for split terminal", {
        sessionId,
        cwd: options?.cwd ?? null,
        shell: resolvedShell,
        err,
      });
      throw err;
    }

    const splitSession: TerminalSession = {
      id: splitSessionId,
      projectId: options?.projectId,
      title: createSplitSessionTitle(options),
      cwd: options?.cwd,
      shell: resolvedShell,
      envVars: options?.envVars,
      startupCmd: options?.startupCmd,
    };

    const unlisten = await listen<PtyStatusPayload>(`pty-status-${splitSessionId}`, (event) => {
      const status = event.payload.status as SessionStatus;
      logTerminalExitStatus(splitSession, event.payload);
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, [splitSessionId]: status },
      }));
    });

    const paneResult = splitPaneLeaf(paneTree, targetPane.id, direction, splitSessionId, createPaneId);
    const newSessions = [...get().sessions, splitSession];
    set((state) => ({
      sessions: newSessions,
      activeSessionId: splitSessionId,
      paneTree: paneResult.tree,
      activePaneId: paneResult.activePaneId,
      splits: {},
      sessionStatuses: { ...state.sessionStatuses, [splitSessionId]: "running" },
      statusListeners: { ...state.statusListeners, [splitSessionId]: unlisten },
    }));

    await useSessionStore.getState().saveSessions(newSessions);
    await useSessionStore.getState().saveActiveSessionId(splitSessionId);
    await useSessionStore.getState().saveSplits([]);

    if (options?.startupCmd) {
      setTimeout(() => {
        invoke("pty_write", { sessionId: splitSessionId, data: options.startupCmd + "\r" }).catch((err) => {
          toast.error("启动命令写入失败", { description: String(err) });
          logError("Failed to write split startup command", {
            sessionId: splitSessionId,
            hasStartupCmd: true,
            startupCmdSummary: summarizeStartupCmd(options.startupCmd),
            err,
          });
        });
      }, 500);
    }

    return splitSessionId;
  },

  unsplitTerminal: async (sessionId) => {
    const pane = findPaneLeafBySession(get().paneTree, sessionId);
    if (!pane) return;
    const behavior = useSettingsStore.getState().unsplitBehavior;
    const result = unsplitPaneLeaf(get().paneTree, pane.id, behavior);
    const closedSessionIds = result.closedSessionIds;

    for (const closedSessionId of closedSessionIds) {
      get().statusListeners[closedSessionId]?.();
    }

    const newStatuses = { ...get().sessionStatuses };
    const newListeners = { ...get().statusListeners };
    const newNotifications = { ...get().tabNotifications };
    const newTabStatuses = { ...get().tabStatuses };
    const newTabStatusDetails = { ...get().tabStatusDetails };
    const newHidden = new Set(get().hiddenBackgroundSessionIds);
    for (const closedSessionId of closedSessionIds) {
      delete newStatuses[closedSessionId];
      delete newListeners[closedSessionId];
      delete newNotifications[closedSessionId];
      delete newTabStatuses[closedSessionId];
      delete newTabStatusDetails[closedSessionId];
      newHidden.delete(closedSessionId);
    }

    const closedSet = new Set(closedSessionIds);
    const remaining = get().sessions.filter((session) => !closedSet.has(session.id));
    set({
      sessions: remaining,
      activeSessionId: result.activeSessionId,
      paneTree: result.tree,
      activePaneId: result.activePaneId,
      sessionStatuses: newStatuses,
      statusListeners: newListeners,
      tabNotifications: newNotifications,
      tabStatuses: newTabStatuses,
      tabStatusDetails: newTabStatusDetails,
      splits: {},
      hiddenBackgroundSessionIds: newHidden,
    });

    await useSessionStore.getState().saveSessions(remaining);
    await useSessionStore.getState().saveActiveSessionId(result.activeSessionId);
    await useSessionStore.getState().saveSplits([]);

    for (const closedSessionId of closedSessionIds) {
      void invoke("pty_close", { sessionId: closedSessionId }).catch((err) => {
        logError("pty_close invoke failed while unsplitting pane", { sessionId: closedSessionId, err });
      });
    }
  },

  setSplitRatio: (splitId, ratio) => {
    set((state) => ({ paneTree: resizePaneSplit(state.paneTree, splitId, ratio) }));
  },

  getNextSessionIdForShortcut: (delta) => {
    return resolveNextSessionIdForShortcut(get().paneTree, get().activePaneId, get().activeSessionId, delta);
  },

  restoreSessions: async (projectMap, projectHealth) => {
    // 防止 StrictMode 双重调用
    if (restoreInProgress) return;
    restoreInProgress = true;

    try {
      const sessionStore = useSessionStore.getState();
      const persistedSessions = sessionStore.sessions;
      const persistedActiveId = sessionStore.activeSessionId;

      if (persistedSessions.length === 0) return;

    const restoredSessions: TerminalSession[] = [];
    const restoredStatuses: Record<string, SessionStatus> = {};
    const restoredListeners: Record<string, UnlistenFn> = {};
    const skippedSessions: string[] = [];

    const newIdMap: Record<string, string> = {}; // oldId -> newId

    for (let i = 0; i < persistedSessions.length; i++) {
      const ps = persistedSessions[i];

      // 检查项目是否存在
      if (ps.projectId) {
        const project = projectMap.get(ps.projectId);
        if (!project) {
          skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
          continue;
        }
        // 检查路径是否有效
        if (!projectHealth[ps.projectId]) {
          // 路径无效但仍创建终端，显示警告
          toast.warning(`项目路径无效: ${project.name}`, {
            description: `路径 ${project.path} 不存在，终端可能无法正常工作`,
          });
        }
      }

      // 重建 PTY
      const normalizedShell = normalizeShellKey(ps.shell);
      const resolvedShell = normalizedShell ?? (ps.projectId ? null : normalizeShellKey(useSettingsStore.getState().defaultShell) ?? null);

      let newSessionId: string;
      try {
        newSessionId = await invoke<string>("pty_create", {
          cwd: ps.cwd ?? null,
          envVars: buildPtyEnvVars(ps.envVars ?? null, resolvedShell),
          shell: resolvedShell,
          hookEnvEnabled: await shouldEnableHookEnv(ps.title, ps.startupCmd),
        });
      } catch (err) {
        logError("Failed to restore session", { session: ps, err });
        skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
        continue;
      }

      newIdMap[ps.id] = newSessionId;

      const restoredSession: TerminalSession = {
        id: newSessionId,
        projectId: ps.projectId,
        title: ps.title,
        cwd: ps.cwd,
        shell: resolvedShell,
        envVars: ps.envVars,
        startupCmd: ps.startupCmd,
      };

      let unlisten: UnlistenFn;
      try {
        unlisten = await listen<PtyStatusPayload>(`pty-status-${newSessionId}`, (event) => {
          const status = event.payload.status as SessionStatus;
          logTerminalExitStatus(restoredSession, event.payload);
          useTerminalStore.setState((state) => ({
            sessionStatuses: { ...state.sessionStatuses, [newSessionId]: status },
          }));
        });
      } catch (err) {
        logError("Failed to register status listener", { sessionId: newSessionId, err });
        await invoke("pty_close", { sessionId: newSessionId }).catch(() => {});
        skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
        continue;
      }

      restoredSessions.push(restoredSession);
      restoredStatuses[newSessionId] = "running";
      restoredListeners[newSessionId] = unlisten;

      // 执行启动命令
      if (ps.startupCmd) {
        setTimeout(() => {
          invoke("pty_write", { sessionId: newSessionId, data: ps.startupCmd + "\r" }).catch((err) => {
            logError("Failed to write startup command on restore", {
              sessionId: newSessionId,
              hasStartupCmd: true,
              startupCmdSummary: summarizeStartupCmd(ps.startupCmd),
              err,
            });
          });
        }, 500);
      }
    }

    // 确定恢复后的 activeSessionId
    let newActiveId: string | null = null;
    if (persistedActiveId && newIdMap[persistedActiveId]) {
      newActiveId = newIdMap[persistedActiveId];
    } else if (restoredSessions.length > 0) {
      newActiveId = restoredSessions[restoredSessions.length - 1].id;
    }

    const restoredPaneTree = restoredSessions.length > 0
      ? createSinglePaneTree(restoredSessions.map((session) => session.id), newActiveId, createPaneId)
      : null;

    set({
      sessions: restoredSessions,
      activeSessionId: newActiveId,
      paneTree: restoredPaneTree,
      activePaneId: restoredPaneTree?.id ?? null,
      sessionStatuses: restoredStatuses,
      statusListeners: restoredListeners,
      splits: {},
    });

    // 更新 sessionStore 的持久化数据（使用新 ID）
    const updatedPersistedSessions = restoredSessions.map((s) => ({
      ...s,
      id: s.id, // 已经是新 ID
    }));
    await sessionStore.saveSessions(updatedPersistedSessions);
    await sessionStore.saveSplits([]);
    await sessionStore.saveActiveSessionId(newActiveId);

    // 显示恢复结果提示
      if (skippedSessions.length > 0) {
        toast.info("部分终端会话未恢复", {
          description: `以下会话因项目不存在或创建失败而跳过: ${skippedSessions.join(", ")}`,
        });
      }
      if (restoredSessions.length > 0) {
        toast.success(`已恢复 ${restoredSessions.length} 个终端会话`);
      }
    } finally {
      restoreInProgress = false;
    }
  },

  hideBackgroundForSession: (sessionId) => {
    const current = get().hiddenBackgroundSessionIds;
    if (current.has(sessionId)) return;
    const next = new Set(current);
    next.add(sessionId);
    set({ hiddenBackgroundSessionIds: next });
  },

  showBackgroundForSession: (sessionId) => {
    const current = get().hiddenBackgroundSessionIds;
    if (!current.has(sessionId)) return;
    const next = new Set(current);
    next.delete(sessionId);
    set({ hiddenBackgroundSessionIds: next });
  },
}));
