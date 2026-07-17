import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { SubagentTranscriptSource, TerminalSession, Project } from "../lib/types";
import { debugConsoleWarn } from "../lib/debugConsole";
import { sourceTool, type SyncedHistoryGroup } from "../lib/externalSessionGrouping";
import { logError, logInfo, logWarn } from "../lib/logger";
import { appendResumeCliArgs, isDirectCodexStartupCommand, normalizeDirectCodexStartupCommand, withCodexLightTuiTheme } from "../lib/projectStartupCommand";
import { getTerminalTheme } from "../lib/terminalThemes";
import { useSettingsStore } from "./settingsStore";
import { useSessionStore } from "./sessionStore";
import { defaultShellForOs, getOsPlatform, normalizeShellForOs, normalizeShellKey, type OsPlatform, type ShellKey } from "../lib/shell";
import { getClaudeProviderOverride, getCodexProviderOverride, getProviderSwitchAppType, isExactCodexProject, parseProjectEnvVars } from "../lib/providerSwitching";
import { useProjectStore } from "./projectStore";
import { appendSyncedHistoryContextArg } from "../lib/syncedHistoryContext";
import { translateCurrent } from "../lib/i18n";
import { findProjectByPath, findWorktreeByPath, resolveProjectForProviderLaunch } from "../lib/terminalProject";
import { terminalProcessManager } from "../terminal/core/TerminalProcessManager";
import {
  addSessionToPaneTree,
  findPaneLeaf,
  findPaneLeafBySession,
  getNextSessionIdForShortcut as resolveNextSessionIdForShortcut,
  moveSessionToPane as moveSessionToPaneTree,
  reorderSessionInPane,
  resizePaneSplit,
  setPaneActiveSession,
  splitPaneEmpty as splitPaneEmptyTree,
  splitPaneLeaf,
  splitExistingSessionToPaneEdge,
  unsplitPaneLeaf,
  type TerminalPaneDropEdge,
  type TerminalPaneNode,
  type TerminalPaneSplitDirection,
} from "./terminalPaneTree";
import {
  collapseTerminalWorkspansToLegacy,
  collectWorkspanSessionIds,
  createTerminalWorkspan,
  findWorkspanByPane,
  findWorkspanBySession,
  getAdjacentWorkspanSessionId,
  mergeTerminalWorkspansAtPaneEdge,
  removeSessionFromTerminalWorkspans,
  reorderTerminalWorkspans,
  restoreTerminalWorkspans,
  sanitizeTerminalWorkspans,
  syncTerminalWorkspanLayout,
  updateTerminalWorkspan,
  type TerminalWorkspan,
} from "./terminalWorkspan";

export type SessionStatus = "running" | "exited" | "error";
export type CliHookSource = "claude" | "codex";
export type CliHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "StopFailure"
  | "PermissionRequest"
  | "SubagentStart"
  | "SubagentStop"
  | "AgentToolStart"
  | "AgentToolStop"
  | "ToolStart"
  | "ToolStop";
export type TabNotificationState = "none" | "running" | "attention" | "done" | "failed";
export type ShellRuntimeEventName = "command_started" | "command_finished" | "prompt_shown";

interface DaemonSessionState {
  alive: boolean;
  cwd?: string | null;
  shell?: string | null;
  createdAtMs?: number;
  taskStatus?: TabNotificationState | null;
  taskUpdatedAtMs?: number | null;
}

interface DaemonSessionMeta extends DaemonSessionState {
  sessionId: string;
}

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
const SUBAGENT_TRANSCRIPT_MAX_CHARS = 4 * 1024 * 1024;

function formatTerminalCreateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.trim().startsWith("provider_not_found")) {
    return translateCurrent("terminal.toast.providerNotFound");
  }
  return message;
}

export interface CliHookPayload {
  tabId: string;
  source?: CliHookSource | null;
  event: CliHookEventName;
  title?: string | null;
  message?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  timestamp?: string | null;
  // 仅 SubagentStart 携带：定位子 Agent 转录 jsonl。
  agentId?: string | null;
  toolUseId?: string | null;
  toolName?: string | null;
  mcpServer?: string | null;
  skillName?: string | null;
  agentType?: string | null;
  agentTranscriptPath?: string | null;
  transcriptPath?: string | null;
  reasoningEffort?: string | null;
  wslDistroName?: string | null;
}

/** 子 Agent 转录面板的实时内容（按订阅 key=伪会话 id 存放）。 */
export interface SubagentTranscriptContent {
  content: string;
  ended: boolean;
  source: SubagentTranscriptSource;
  truncatedBytes?: number;
  /** 重置序号：reset 或前部裁剪时自增；序号不变 ⇒ content 相对上次为纯尾部追加，消费方可增量解析。 */
  resetSeq: number;
}

interface SubagentTranscriptSubscribeResult {
  path: string;
  initialContent: string;
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
  worktreeId?: string;
}

interface HookToolStatus {
  status: "directoryMissing" | "notInstalled" | "partialInstalled" | "installed";
}

interface HookSettingsStatusPayload {
  claude: HookToolStatus;
  codex: HookToolStatus;
  claudeAutoRepaired?: boolean;
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
  workspans: TerminalWorkspan[];
  activeWorkspanId: string | null;
  sessionStatuses: Record<string, SessionStatus>;
  statusListeners: Record<string, UnlistenFn>;
  tabNotifications: Record<string, TabNotificationState>;
  tabStatuses: Record<string, TabStatusSources>;
  tabStatusDetails: Record<string, TabStatusDetails>;
  splits: Record<string, SplitState>;
  hiddenBackgroundSessionIds: Set<string>;
  /** 仅运行态：XTerm 输出监听就绪后才可执行 daemon attach。 */
  daemonAttachPendingSessionIds: Set<string>;
  subagentTranscripts: Record<string, SubagentTranscriptContent>;
  createSession: (projectId?: string, cwd?: string, title?: string, startupCmd?: string, envVars?: Record<string, string>, shell?: string, paneId?: string, worktreeId?: string) => Promise<string>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  setWorkspanModeEnabled: (enabled: boolean) => void;
  setActiveWorkspan: (id: string) => void;
  reorderWorkspans: (fromId: string, toId: string) => void;
  renameWorkspan: (id: string, title: string) => void;
  mergeWorkspanAtPaneEdge: (sourceId: string, targetId: string, targetPaneId: string, edge: TerminalPaneDropEdge) => void;
  updateSessionCwd: (sessionId: string, cwd: string) => void;
  updateSessionTerminalSnapshot: (sessionId: string, initialTerminalOutput: string) => void;
  markAttentionInputHandled: (sessionId: string) => void;
  handleCliHookEvent: (payload: CliHookPayload) => string | null;
  handleShellRuntimeEvent: (payload: ShellRuntimePayload) => string | null;
  reorderSessions: (fromId: string, toId: string) => void;
  moveSessionToPane: (sessionId: string, targetPaneId: string, beforeSessionId?: string) => void;
  splitSessionToPaneEdge: (sessionId: string, targetPaneId: string, edge: TerminalPaneDropEdge) => void;
  renameSession: (id: string, title: string) => void;
  splitTerminal: (sessionId: string, direction: TerminalPaneSplitDirection, options?: SplitTerminalOptions) => Promise<string | null>;
  openFileEditorPane: (project: Project) => string;
  openSyncedHistoryPane: (group: SyncedHistoryGroup, project?: Project) => Promise<string>;
  /** Split the current pane into two, creating a new empty leaf (no sessions). Used by batch launch to create panes for different root groups. */
  splitPaneEmpty: (paneId: string, direction: TerminalPaneSplitDirection) => void;
  unsplitTerminal: (sessionId: string) => Promise<void>;
  setSplitRatio: (splitId: string, ratio: number) => void;
  getNextSessionIdForShortcut: (delta: 1 | -1) => string | null;
  restoreSessions: (projectMap: Map<string, Project>, projectHealth: Record<string, boolean>) => Promise<void>;
  /** 从 daemon 恢复单个后台任务并聚焦；执行中和已完成会话都可回放。 */
  attachDaemonSession: (sessionId: string) => Promise<boolean>;
  /** 终止并移除单个 daemon 后台任务及终端恢复数据。 */
  discardDaemonSession: (sessionId: string) => Promise<void>;
  /** 合并态（hook+shell）为 running 的真实 PTY 会话 id，供退出拦截判定任务是否在跑（Issue #123 Phase 1）。 */
  getRunningTaskSessionIds: () => string[];
  hideBackgroundForSession: (sessionId: string) => void;
  showBackgroundForSession: (sessionId: string) => void;
  /** 收到 CLI SubagentStart：在发起 Tab 所在 pane 分屏出只读转录面板并开始 tail。 */
  openSubagentTranscript: (payload: CliHookPayload) => Promise<void>;
  /** 收到 CLI SubagentStop：标记完成并延迟关闭对应子 Agent 转录面板。 */
  finishSubagentTranscript: (payload: CliHookPayload) => void;
  /** tail 增量推送：追加（reset=true 时替换）某转录面板内容。 */
  appendSubagentTranscript: (key: string, content: string, reset: boolean) => void;
}

// 防止 StrictMode 双重调用
let restoreInProgress = false;

function basenameFromPath(path: string | null | undefined): string | null {
  const normalized = path?.trim().replace(/\\/g, "/").replace(/\/+$/g, "") ?? "";
  if (!normalized) return null;
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function isGenericDaemonSessionTitle(title: string | null | undefined): boolean {
  const normalized = title?.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "terminal" ||
    normalized === translateCurrent("terminal.backgroundTasks.untitled").toLowerCase() ||
    normalized === "未命名后台任务" ||
    normalized === "untitled background task";
}

function normalizeDaemonTaskStatus(status: string | null | undefined): TabNotificationState | null {
  if (status === "running" || status === "attention" || status === "done" || status === "failed") return status;
  return null;
}

function resolveDaemonAttachTaskStatus(attach: DaemonSessionState): TabNotificationState {
  return normalizeDaemonTaskStatus(attach.taskStatus) ?? (attach.alive ? "running" : "done");
}

function resolveDaemonAttachUpdatedAt(attach: DaemonSessionState): string {
  const updatedAtMs = attach.taskUpdatedAtMs;
  if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
    return new Date(updatedAtMs).toISOString();
  }
  return new Date().toISOString();
}

function resolveAttachedDaemonSession(
  persisted: TerminalSession | undefined,
  attach: DaemonSessionState
): Pick<TerminalSession, "projectId" | "worktreeId" | "title" | "cwd" | "shell"> {
  const projectState = useProjectStore.getState();
  const cwd = persisted?.cwd ?? attach.cwd ?? undefined;
  const worktree = persisted?.worktreeId
    ? projectState.worktrees.find((item) => item.id === persisted.worktreeId) ?? null
    : findWorktreeByPath(projectState.worktrees, cwd);
  const project = persisted?.projectId
    ? projectState.projects.find((item) => item.id === persisted.projectId) ?? null
    : worktree
      ? projectState.projects.find((item) => item.id === worktree.project_id) ?? null
      : findProjectByPath(projectState.projects, cwd);
  const fallbackTitle = worktree?.name || project?.name || basenameFromPath(cwd) || translateCurrent("terminal.backgroundTasks.untitled");
  return {
    projectId: persisted?.projectId ?? project?.id,
    worktreeId: persisted?.worktreeId ?? worktree?.id,
    title: isGenericDaemonSessionTitle(persisted?.title) ? fallbackTitle : persisted!.title,
    cwd,
    shell: persisted?.shell ?? attach.shell,
  };
}

// setActive 防抖：高频切换标签时合并持久化写入
let saveActiveIdTimer: ReturnType<typeof setTimeout> | null = null;
let paneIdSeq = 0;
let workspanIdSeq = 0;
let subagentSeq = 0;
const subagentCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const subagentDiscoveryTimers = new Map<string, ReturnType<typeof setInterval>>();
const subagentTranscriptRetryTimers = new Map<string, ReturnType<typeof setInterval>>();
const SUBAGENT_CLOSE_DELAY_MS = 1500;
const SUBAGENT_CHILD_JSONL_CLOSE_DELAY_MS = 10_000;
const SUBAGENT_DISCOVERY_INTERVAL_MS = 1000;
const SUBAGENT_DISCOVERY_TTL_MS = 15000;
const PTY_ORPHAN_RECONCILE_INTERVAL_MS = 30_000;
const TERMINAL_STORE_IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type WindowWithPtyOrphanTimer = Window & {
  __CLI_MANAGER_PTY_ORPHAN_RECONCILE_TIMER__?: ReturnType<typeof setInterval>;
};

function createPaneId() {
  paneIdSeq += 1;
  return `pane-${Date.now().toString(36)}-${paneIdSeq.toString(36)}`;
}

function createWorkspanId() {
  workspanIdSeq += 1;
  return `workspan-${Date.now().toString(36)}-${workspanIdSeq.toString(36)}`;
}

function buildWorkspanMirror(
  workspans: TerminalWorkspan[],
  requestedActiveWorkspanId: string | null
): Pick<TerminalStore, "workspans" | "activeWorkspanId" | "paneTree" | "activePaneId" | "activeSessionId"> {
  const activeWorkspan = workspans.find((workspan) => workspan.id === requestedActiveWorkspanId)
    ?? workspans[0]
    ?? null;
  return {
    workspans,
    activeWorkspanId: activeWorkspan?.id ?? null,
    paneTree: activeWorkspan?.paneTree ?? null,
    activePaneId: activeWorkspan?.activePaneId ?? null,
    activeSessionId: activeWorkspan?.activeSessionId ?? null,
  };
}

function persistWorkspanState(
  workspans: TerminalWorkspan[],
  activeWorkspanId: string | null,
  sessions: TerminalSession[]
) {
  void useSessionStore.getState().saveWorkspans(workspans, activeWorkspanId, sessions).catch((err) => {
    logError("Failed to persist terminal workspans", err);
  });
}

function createFileEditorSessionId(projectId: string): string {
  return `file-editor:${projectId}`;
}

function isPersistableSession(session: TerminalSession | undefined): boolean {
  return !!session && session.kind !== "subagent-transcript" && session.kind !== "file-editor" && session.kind !== "synced-history";
}

function hasBackendPty(session: TerminalSession): boolean {
  return session.kind !== "subagent-transcript" && session.kind !== "file-editor";
}

function startPtyOrphanReconcileHeartbeat() {
  if (!TERMINAL_STORE_IN_TAURI || typeof window === "undefined") return;
  const host = window as WindowWithPtyOrphanTimer;
  if (host.__CLI_MANAGER_PTY_ORPHAN_RECONCILE_TIMER__) return;
  host.__CLI_MANAGER_PTY_ORPHAN_RECONCILE_TIMER__ = setInterval(() => {
    const activeSessionIds = useTerminalStore
      .getState()
      .sessions
      .filter(hasBackendPty)
      .map((session) => session.id);
    if (activeSessionIds.length === 0) return;
    void invoke("pty_reconcile_active_sessions", { activeSessionIds }).catch((err) => {
      logError("pty_reconcile_active_sessions invoke failed", { activeSessionIds: activeSessionIds.length, err });
    });
  }, PTY_ORPHAN_RECONCILE_INTERVAL_MS);
}

function createSplitSessionTitle(options?: SplitTerminalOptions) {
  return options?.title ?? "Split Terminal";
}

function scheduleSaveActiveId(id: string | null) {
  if (saveActiveIdTimer !== null) clearTimeout(saveActiveIdTimer);
  saveActiveIdTimer = setTimeout(() => {
    saveActiveIdTimer = null;
    const session = id ? useTerminalStore.getState().sessions.find((item) => item.id === id) : undefined;
    useSessionStore.getState().saveActiveSessionId(isPersistableSession(session) ? id : null).catch(() => {});
  }, 200);
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function inferWslDistroFromCwd(cwd: string | null | undefined): string | null {
  const value = trimOptional(cwd);
  if (!value) return null;
  const normalized = value.replace(/\//g, "\\");
  const match = normalized.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\|$)/i);
  return match?.[1]?.trim() || null;
}

function resolveHookWslDistroName(payload: CliHookPayload): string | null {
  return trimOptional(payload.wslDistroName) ?? inferWslDistroFromCwd(payload.cwd);
}

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function isSameTranscriptPath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function createSubagentPaneId(parentTabId: string, agentId: string | null, toolUseId: string | null, childTranscriptPath: string | null): string {
  if (agentId) return `subagent:${agentId}`;
  if (toolUseId) return `subagent:tool:${toolUseId}`;
  if (childTranscriptPath) return `subagent:path:${hashString(childTranscriptPath)}`;
  subagentSeq += 1;
  return `subagent:${parentTabId}:${Date.now().toString(36)}:${subagentSeq.toString(36)}`;
}

function buildSubagentTitle(
  parentSession: TerminalSession | undefined,
  agentType: string | null,
  existingSubagentCount: number
): string {
  const parentTitle = parentSession?.title || "Terminal";
  const agentLabel = agentType || "子Agent";

  // 如果同一父终端已经有子 Agent，添加序号
  if (existingSubagentCount > 0) {
    return `${agentLabel} #${existingSubagentCount + 1} (${parentTitle})`;
  }

  // 首个子 Agent：显示父终端标题，便于识别来源
  return `${agentLabel} (${parentTitle})`;
}

function resolveSubagentTranscriptSource(payload: CliHookPayload): SubagentTranscriptSource {
  const childPath = trimOptional(payload.agentTranscriptPath);
  const parentPath = trimOptional(payload.transcriptPath);

  if (childPath && !isSameTranscriptPath(childPath, parentPath)) {
    return {
      kind: "child-jsonl",
      transcriptPath: childPath,
      parentTranscriptPath: parentPath ?? undefined,
    };
  }

  if (payload.source === "codex" && trimOptional(payload.agentId) && trimOptional(payload.sessionId)) {
    return {
      kind: "pending",
      parentTranscriptPath: parentPath ?? undefined,
      reason: "waiting for Codex rollout transcript discovery",
    };
  }

  if (payload.event === "AgentToolStart" || payload.event === "AgentToolStop") {
    return {
      kind: "pending",
      parentTranscriptPath: parentPath ?? undefined,
      reason: childPath ? "child transcript path equals parent transcript path" : "waiting for Agent tool child transcript discovery",
    };
  }

  if (parentPath) {
    return {
      kind: "parent-jsonl",
      transcriptPath: parentPath,
      parentTranscriptPath: parentPath,
      reason: childPath ? "child transcript path equals parent transcript path" : "missing child transcript path",
    };
  }

  return {
    kind: "lifecycle-only",
    reason: "missing transcript path",
  };
}

function shouldUpgradeSubagentSource(previous: SubagentTranscriptSource | undefined, next: SubagentTranscriptSource): boolean {
  if (!previous) return true;
  if (previous.kind === "child-jsonl") return next.kind === "child-jsonl" && previous.transcriptPath !== next.transcriptPath;
  if (next.kind === "child-jsonl") return true;
  if (previous.kind === "pending" && next.kind !== "pending") return true;
  if (previous.kind === "lifecycle-only" && next.kind === "parent-jsonl") return true;
  return previous.kind === next.kind && previous.reason !== next.reason;
}

function mergeSubagentSource(previous: SubagentTranscriptSource | undefined, next: SubagentTranscriptSource): SubagentTranscriptSource {
  if (!shouldUpgradeSubagentSource(previous, next)) return previous ?? next;
  if (next.kind === "child-jsonl") return next;
  return {
    ...next,
    parentTranscriptPath: next.parentTranscriptPath ?? previous?.parentTranscriptPath,
  };
}

function shouldSubscribeSubagentSource(previous: SubagentTranscriptSource | undefined, next: SubagentTranscriptSource): boolean {
  return next.kind === "child-jsonl" && Boolean(next.transcriptPath) && previous?.transcriptPath !== next.transcriptPath;
}

function shouldAttemptDerivedChildTranscript(payload: CliHookPayload, source: SubagentTranscriptSource): boolean {
  if (payload.source !== "claude" || source.kind === "child-jsonl") return false;
  return Boolean(trimOptional(payload.agentId) && trimOptional(payload.cwd) && trimOptional(payload.sessionId));
}

function stopSubagentTranscriptRetry(sessionId: string, reason: string) {
  const timer = subagentTranscriptRetryTimers.get(sessionId);
  if (!timer) return;
  clearInterval(timer);
  subagentTranscriptRetryTimers.delete(sessionId);
  logInfo("[subagent_transcript] stopped transcript discovery retry", { sessionId, reason });
}

function startSubagentTranscriptRetry(sessionId: string, attempt: () => Promise<boolean>) {
  if (subagentTranscriptRetryTimers.has(sessionId)) return;

  const startTime = Date.now();
  let running = false;
  const intervalId = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const store = useTerminalStore.getState();
    const transcript = store.subagentTranscripts[sessionId];
    if (
      elapsed > SUBAGENT_DISCOVERY_TTL_MS ||
      !store.sessions.some((session) => session.id === sessionId) ||
      transcript?.source.kind === "child-jsonl"
    ) {
      stopSubagentTranscriptRetry(sessionId, elapsed > SUBAGENT_DISCOVERY_TTL_MS ? "ttl_expired" : "inactive");
      return;
    }
    if (running) return;

    running = true;
    void attempt()
      .then((subscribed) => {
        if (subscribed) stopSubagentTranscriptRetry(sessionId, "subscribed");
      })
      .finally(() => {
        running = false;
      });
  }, SUBAGENT_DISCOVERY_INTERVAL_MS);

  subagentTranscriptRetryTimers.set(sessionId, intervalId);
  logInfo("[subagent_transcript] started transcript discovery retry", {
    sessionId,
    intervalMs: SUBAGENT_DISCOVERY_INTERVAL_MS,
    ttlMs: SUBAGENT_DISCOVERY_TTL_MS,
  });
}

/** AgentToolStart pending 兜底：短时轮询 subagents 目录发现新 child JSONL。 */
function startSubagentDiscovery(
  parentTabId: string,
  parentSessionId: string | null,
  cwd: string | null,
  wslDistroName: string | null
) {
  if (!cwd || !parentSessionId) {
    logWarn("[subagent_discovery] skipped: missing cwd/sessionId", { parentTabId, cwd, parentSessionId, wslDistroName });
    return;
  }
  const key = `${parentTabId}:${parentSessionId}`;
  if (subagentDiscoveryTimers.has(key)) {
    logInfo("[subagent_discovery] already running", { parentTabId, parentSessionId, wslDistroName });
    return;
  }

  const startTime = Date.now();
  let knownAgents = new Set<string>();

  const intervalId = setInterval(() => {
    const elapsed = Date.now() - startTime;
    if (elapsed > SUBAGENT_DISCOVERY_TTL_MS) {
      clearInterval(intervalId);
      subagentDiscoveryTimers.delete(key);
      logInfo("[subagent_discovery] TTL expired", { parentTabId, elapsed });
      return;
    }

    logInfo("[subagent_discovery] scan tick", { parentTabId, cwd, sessionId: parentSessionId, wslDistroName, elapsed });
    void invoke<string[]>("subagent_transcript_discover", { cwd, sessionId: parentSessionId, wslDistroName })
      .then((files) => {
        logInfo("[subagent_discovery] scan result", { parentTabId, count: files.length, files });
        for (const filename of files) {
          if (knownAgents.has(filename)) continue;
          knownAgents.add(filename);

          const match = filename.match(/^agent-(.+)\.jsonl$/);
          if (!match) continue;
          const discoveredAgentId = match[1];

          logInfo("[subagent_discovery] found new child", { parentTabId, filename, discoveredAgentId });

          const store = useTerminalStore.getState();
          const existingSession = store.sessions.find(
            (s) =>
              s.kind === "subagent-transcript" &&
              s.subagent?.parentSessionId === parentTabId &&
              (s.subagent.agentId === discoveredAgentId || s.id === `subagent:${discoveredAgentId}`)
          );

          if (existingSession) {
            // 推导 child JSONL 路径并升级 pane
            logInfo("[subagent_discovery] subscribing discovered child", {
              parentTabId,
              existingSessionId: existingSession.id,
              cwd,
              sessionId: parentSessionId,
              discoveredAgentId,
              wslDistroName,
            });
            void invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
              key: existingSession.id,
              transcriptPath: null,
              cwd,
              sessionId: parentSessionId,
              agentId: discoveredAgentId,
              wslDistroName,
            })
              .then((result) => {
                const childSource: SubagentTranscriptSource = {
                  kind: "child-jsonl",
                  transcriptPath: result.path,
                };
                useTerminalStore.setState((state) => ({
                  sessions: state.sessions.map((session) =>
                    session.id === existingSession.id && session.kind === "subagent-transcript" && session.subagent
                      ? { ...session, subagent: { ...session.subagent, agentId: discoveredAgentId, source: childSource } }
                      : session
                  ),
                  subagentTranscripts: {
                    ...state.subagentTranscripts,
                    [existingSession.id]: {
                      ...(state.subagentTranscripts[existingSession.id] ?? { content: "", ended: false, resetSeq: 0 }),
                      source: childSource,
                    },
                  },
                }));
                if (result.initialContent) {
                  useTerminalStore.getState().appendSubagentTranscript(existingSession.id, result.initialContent, true);
                }
                logInfo("[subagent_discovery] upgraded to child-jsonl", {
                  parentTabId,
                  agentId: discoveredAgentId,
                  derivedPath: result.path,
                  initialBytes: result.initialContent.length,
                });
              })
              .catch((err) => logWarn("[subagent_discovery] subscribe failed", { parentTabId, agentId: discoveredAgentId, err }));
          }
        }

        if (knownAgents.size > 0) {
          clearInterval(intervalId);
          subagentDiscoveryTimers.delete(key);
          logInfo("[subagent_discovery] stopped after finding agents", { parentTabId, count: knownAgents.size });
        }
      })
      .catch((err) => {
        logWarn("[subagent_discovery] scan failed", { parentTabId, err });
      });
  }, SUBAGENT_DISCOVERY_INTERVAL_MS);

  subagentDiscoveryTimers.set(key, intervalId);
  logInfo("[subagent_discovery] started", { parentTabId, cwd, sessionId: parentSessionId, wslDistroName, ttlMs: SUBAGENT_DISCOVERY_TTL_MS });
}

function findSubagentSessionId(sessions: TerminalSession[], payload: CliHookPayload): string | null {
  const agentId = payload.agentId?.trim() || null;
  if (agentId) {
    const byAgent = sessions.find(
      (session) =>
        session.kind === "subagent-transcript" &&
        (session.subagent?.agentId === agentId || session.id === `subagent:${agentId}`)
    );
    if (byAgent) return byAgent.id;
  }

  const toolUseId = payload.toolUseId?.trim() || null;
  if (toolUseId) {
    const byTool = sessions.find(
      (session) =>
        session.kind === "subagent-transcript" &&
        (session.subagent?.toolUseId === toolUseId || session.id === `subagent:tool:${toolUseId}`)
    );
    if (byTool) return byTool.id;
  }

  // Fallback：仅当 payload 既无 agentId 也无 toolUseId（完全无法识别）时，才通过 parentTabId 推断。
  // 若 payload 带 agentId/toolUseId 但未匹配到，说明是新的子 Agent，应返回 null 以创建新 Tab，
  // 避免并发场景下第二个子 Agent 被错误合并到第一个。
  if (agentId || toolUseId) return null;

  const candidates = sessions.filter(
    (session) => session.kind === "subagent-transcript" && session.subagent?.parentSessionId === payload.tabId
  );
  return candidates.length === 1 ? candidates[0].id : null;
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
  // SessionStart 仅用于回传 sessionId 绑定 Tab，不改变 Tab 状态
  if (event === "SessionStart") return null;
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
    normalized === "powershell" ||
    normalized === "pwsh" ||
    normalized === "cmd" ||
    normalized === "gitbash"
  );
}

function isShellRuntimeMonitoringEnabled(): boolean {
  return useSettingsStore.getState().shellRuntimeMonitoringEnabled;
}

function resolveShellForPty(shell: string | null | undefined, hasProject: boolean, os: OsPlatform): string | null {
  const inputShell = normalizeShellForOs(shell, os);
  if (inputShell) return inputShell;
  const customShell = shell?.trim();
  if (customShell && !normalizeShellKey(customShell)) return customShell;
  if (hasProject) return null;
  return normalizeShellForOs(useSettingsStore.getState().defaultShell, os) ?? defaultShellForOs(os);
}

function isLightHexColor(value: string | undefined): boolean {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return false;
  const r = Number.parseInt(value.slice(1, 3), 16);
  const g = Number.parseInt(value.slice(3, 5), 16);
  const b = Number.parseInt(value.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

function isCurrentTerminalBackgroundLight(): boolean {
  const settings = useSettingsStore.getState();
  const theme = getTerminalTheme(settings.terminalThemeName, settings.resolvedTheme, settings.lightThemePalette, settings.darkThemePalette);
  return isLightHexColor(theme.background);
}

function prepareStartupCommandForPty(command: string | undefined, shell: ShellKey | null): string | undefined {
  if (!command || shell !== "gitbash" || !isCurrentTerminalBackgroundLight()) return command;
  return withCodexLightTuiTheme(command);
}

// startupCmd 里 codex/claude 可能出现在任意位置（如 `wsl codex`、`claude --settings ...`），
// 与 isDirectCodexStartupCommand（要求 codex 位于命令开头）不同，这里用更宽松的整词匹配做类型判定。
const CODEX_COMMAND_PATTERN = /(?:^|\s)codex(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;
const CLAUDE_COMMAND_PATTERN = /(?:^|\s)claude(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i;

// 恢复会话时判定它是否为 codex/claude 这类 TUI CLI 会话。判定依据 = startupCmd 文本 + 项目 cli_tool 配置。
// 判不出（如普通 pwsh/bash）返回 null，走 shell 分支（静态贴回 scrollback）。
function detectCliResumeKind(
  startupCmd: string | undefined,
  project: Project | undefined
): "claude" | "codex" | null {
  const cmd = startupCmd?.trim() ?? "";
  const projectKind = project ? getProviderSwitchAppType(project) : null;
  // codex 优先：codex 项目可能带自定义 startupCmd，仍应当 codex resume。
  if (projectKind === "codex" || (project ? isExactCodexProject(project) : false) || CODEX_COMMAND_PATTERN.test(cmd)) {
    return "codex";
  }
  if (projectKind === "claude" || CLAUDE_COMMAND_PATTERN.test(cmd)) {
    return "claude";
  }
  return null;
}

// 构造 CLI 会话的 resume 启动命令。为什么不贴 scrollback 而改走 resume：codex/claude 启动用绝对光标
// 定位整屏重绘，会盖掉我们贴回的历史文本（见 research/tui-startup-clear-sequences.md），因此改由 CLI
// 自己 resume 重画上次对话。有 cliSessionId 走带 id 的 resume；无 id 兜底续最近一次（用户已拍板）。
function buildCliResumeStartupCommand(
  kind: "claude" | "codex",
  cliSessionId: string | undefined,
  project: Project | undefined
): string {
  const id = cliSessionId?.trim();
  const hasValidId = !!id && !/\s/.test(id) && !/[\r\n]/.test(id);
  if (kind === "codex") {
    const base = hasValidId ? `codex resume --no-alt-screen ${id}` : "codex resume --no-alt-screen --last";
    return appendResumeCliArgs(base, "codex", project ?? null);
  }
  const base = hasValidId ? `claude --resume ${id}` : "claude --continue";
  return appendResumeCliArgs(base, "claude", project ?? null);
}


function buildDirectCodexLaunchCommand(command: string): string {
  const normalized = normalizeDirectCodexStartupCommand(command) ?? command.trim();
  return `\x0c${normalized}`;
}

export function formatStartupInputForPty(command: string, _shell?: ShellKey | null): string {
  if (!isDirectCodexStartupCommand(command)) return `${command}\r`;
  return `${buildDirectCodexLaunchCommand(command)}\r`;
}

export function formatManualDirectCodexInputForPty(command: string, shell?: ShellKey | null): string {
  return formatStartupInputForPty(command, shell ?? null);
}

export interface DetachedPtyLaunchOptions {
  projectId?: string;
  worktreeId?: string;
  cwd?: string | null;
  startupCmd?: string | null;
  envVars?: Record<string, string> | null;
  shell?: string | null;
}

export interface DetachedPtyLaunchResult {
  sessionId: string;
  shell: string | null;
  startupCmd?: string;
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

async function shouldEnableHookEnv(): Promise<boolean> {
  const settings = useSettingsStore.getState();
  if (!settings.claudeHookBridgeEnabled && !settings.codexHookBridgeEnabled) return false;
  try {
    const status = await invoke<HookSettingsStatusPayload>("hook_settings_get_status", {
      selectedDir: settings.claudeHookConfigDir?.trim() || null,
      codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
      ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
      autoRepair: settings.claudeHookBridgeEnabled && settings.claudeHookAutoRepairKnownInstalled,
    });
    return (
      (settings.claudeHookBridgeEnabled && status.claude.status === "installed") ||
      (settings.codexHookBridgeEnabled && status.codex.status === "installed")
    );
  } catch (err) {
    logError("hook_settings_get_status failed while deciding terminal hook env", { err });
    return false;
  }
}

function buildPtyEnvVars(
  envVars?: Record<string, string> | null,
  shell?: string | null
): Record<string, string> | null {
  const next = { ...(envVars ?? {}) };
  if (isShellRuntimeMonitoringEnabled() && supportsShellRuntimeInjection(shell)) {
    next[SHELL_RUNTIME_MONITORING_ENV] = "1";
  } else {
    delete next[SHELL_RUNTIME_MONITORING_ENV];
  }
  return Object.keys(next).length > 0 ? next : null;
}

function getProviderLaunchProject(projectId?: string, worktreeId?: string) {
  if (!projectId) return null;
  const projectState = useProjectStore.getState();
  const project = projectState.projects.find((item) => item.id === projectId);
  return project ? resolveProjectForProviderLaunch(project, projectState.worktrees, worktreeId) : null;
}

function getCodexProviderLaunchConfig(projectId?: string, startupCmd?: string | null, worktreeId?: string) {
  const project = getProviderLaunchProject(projectId, worktreeId);
  if (!project || !isExactCodexProject(project) || project.startup_cmd.trim() || !startupCmd?.trim()) {
    return null;
  }
  const override = getCodexProviderOverride(project);
  if (!override) return null;
  const settings = useSettingsStore.getState();
  return {
    providerId: override.providerId,
    dbPath: settings.ccSwitchDbPath ?? undefined,
    codexConfigDir: settings.codexHookConfigDir ?? undefined,
  };
}

function getClaudeProviderLaunchConfig(projectId?: string, worktreeId?: string) {
  const project = getProviderLaunchProject(projectId, worktreeId);
  if (!project || getProviderSwitchAppType(project) !== "claude") return null;
  const override = getClaudeProviderOverride(project);
  if (!override) return null;
  const settings = useSettingsStore.getState();
  return {
    projectId: project.id,
    providerId: override.providerId,
    dbPath: settings.ccSwitchDbPath ?? undefined,
  };
}

export async function createDetachedPtyProcess(options: DetachedPtyLaunchOptions): Promise<DetachedPtyLaunchResult> {
  const os = await getOsPlatform();
  const resolvedShell = resolveShellForPty(options.shell, !!options.projectId, os);
  const launchStartupCmd = prepareStartupCommandForPty(options.startupCmd ?? undefined, normalizeShellKey(resolvedShell) ?? null);
  const sessionId = await terminalProcessManager.create({
    cwd: options.cwd ?? null,
    envVars: buildPtyEnvVars(options.envVars ?? null, resolvedShell),
    shell: resolvedShell,
    hookEnvEnabled: await shouldEnableHookEnv(),
    claudeProvider: getClaudeProviderLaunchConfig(options.projectId, options.worktreeId),
    codexProvider: getCodexProviderLaunchConfig(options.projectId, options.startupCmd, options.worktreeId),
  });

  return {
    sessionId,
    shell: resolvedShell,
    startupCmd: launchStartupCmd,
  };
}

function isCliManagerSyncArtifactText(value: string): boolean {
  const text = value.toLowerCase();
  return (
    text.includes("cli-manager 同步聚合会话")
    || text.includes(".cli-manager/synced-history/")
    || text.includes("同步记录已加载")
  );
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  paneTree: null,
  activePaneId: null,
  workspans: [],
  activeWorkspanId: null,
  sessionStatuses: {},
  statusListeners: {},
  tabNotifications: {},
  tabStatuses: {},
  tabStatusDetails: {},
  splits: {},
  hiddenBackgroundSessionIds: new Set<string>(),
  daemonAttachPendingSessionIds: new Set<string>(),
  subagentTranscripts: {},

  updateSessionCwd: (sessionId, cwd) => set((state) => ({
    sessions: state.sessions.map((session) => (
      session.id === sessionId ? { ...session, cwd } : session
    )),
  })),

  updateSessionTerminalSnapshot: (sessionId, initialTerminalOutput) => set((state) => ({
    sessions: state.sessions.map((session) => (
      session.id === sessionId && (session.kind ?? "pty") === "pty" && session.initialTerminalOutput !== initialTerminalOutput
        ? { ...session, initialTerminalOutput }
        : session
    )),
  })),

  createSession: async (projectId, cwd, title, startupCmd, envVars, shell, paneId, worktreeId) => {
    const os = await getOsPlatform();
    const resolvedShell = resolveShellForPty(shell, !!projectId, os);
    const launchStartupCmd = prepareStartupCommandForPty(startupCmd, normalizeShellKey(resolvedShell) ?? null);

    let sessionId: string;
    try {
      sessionId = await terminalProcessManager.create({
        cwd: cwd ?? null,
        envVars: buildPtyEnvVars(envVars ?? null, resolvedShell),
        shell: resolvedShell,
        hookEnvEnabled: await shouldEnableHookEnv(),
        claudeProvider: getClaudeProviderLaunchConfig(projectId, worktreeId),
        codexProvider: getCodexProviderLaunchConfig(projectId, startupCmd, worktreeId),
      });
    } catch (err) {
      const description = formatTerminalCreateError(err);
      toast.error(translateCurrent("terminal.toast.createFailed"), { description });
      logError("PtyHost create failed", {
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
      worktreeId,
      title: title ?? "Terminal",
      cwd,
      shell: resolvedShell,
      envVars,
      startupCmd,
    };

    const unlisten = await terminalProcessManager.subscribeStatus(sessionId, (payload) => {
      const status = payload.status as SessionStatus;
      logTerminalExitStatus(session, payload);
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, [sessionId]: status },
      }));
    });

    const state = get();
    const newSessions = [...state.sessions, session];
    let workspans: TerminalWorkspan[];
    let activeWorkspanId: string;
    const workspanEnabled = useSettingsStore.getState().workspanEnabled;
    const explicitTargetWorkspan = paneId ? findWorkspanByPane(state.workspans, paneId) : null;
    const targetWorkspan = explicitTargetWorkspan
      ?? (!workspanEnabled
        ? state.workspans.find((workspan) => workspan.id === state.activeWorkspanId) ?? state.workspans[0] ?? null
        : null);
    if (targetWorkspan) {
      const paneResult = addSessionToPaneTree(
        targetWorkspan.paneTree,
        explicitTargetWorkspan ? paneId ?? null : targetWorkspan.activePaneId,
        sessionId,
        createPaneId
      );
      workspans = updateTerminalWorkspan(state.workspans, targetWorkspan.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId, sessionId)
      ));
      activeWorkspanId = targetWorkspan.id;
    } else {
      const workspan = createTerminalWorkspan(createWorkspanId(), createPaneId(), sessionId);
      workspans = [...state.workspans, workspan];
      activeWorkspanId = workspan.id;
    }
    const mirror = buildWorkspanMirror(workspans, activeWorkspanId);
    set({
      sessions: newSessions,
      ...mirror,
      sessionStatuses: { ...state.sessionStatuses, [sessionId]: "running" },
      statusListeners: { ...state.statusListeners, [sessionId]: unlisten },
    });

    // 持久化到 sessionStore
    await useSessionStore.getState().saveSessions(newSessions);
    await useSessionStore.getState().saveActiveSessionId(sessionId);
    await useSessionStore.getState().saveWorkspans(workspans, activeWorkspanId, newSessions);

    if (launchStartupCmd) {
      setTimeout(() => {
        terminalProcessManager.write(sessionId, formatStartupInputForPty(launchStartupCmd, normalizeShellKey(resolvedShell) ?? null)).catch((err) => {
          toast.error("启动命令写入失败", { description: String(err) });
          logError("Failed to write startup command", {
            sessionId,
            hasStartupCmd: true,
            startupCmdSummary: summarizeStartupCmd(launchStartupCmd),
            err,
          });
        });
      }, 500);
    }

    return sessionId;
  },

  closeSession: async (id) => {
    const state = get();
    const ptySessionIds = [id];
    const closingSession = state.sessions.find((s) => s.id === id);
    const isTranscript = closingSession?.kind === "subagent-transcript";
    const isFileEditor = closingSession?.kind === "file-editor";
    const closeTimer = subagentCloseTimers.get(id);
    if (closeTimer) {
      clearTimeout(closeTimer);
      subagentCloseTimers.delete(id);
    }
    stopSubagentTranscriptRetry(id, "session_closed");

    // 必须在 set sessions 之前记录原索引，否则后续 findIndex 永远返回 -1，
    // 导致 persistedSplits 永远清不掉（历史 bug）。
    const closedIndex = state.sessions.findIndex((s) => s.id === id);
    const remaining = state.sessions.filter((s) => s.id !== id);
    const newStatuses = { ...state.sessionStatuses };
    const newListeners = { ...state.statusListeners };
    const newNotifications = { ...state.tabNotifications };
    const newTabStatuses = { ...state.tabStatuses };
    const newTabStatusDetails = { ...state.tabStatusDetails };
    const newSubagentTranscripts = { ...state.subagentTranscripts };
    delete newSubagentTranscripts[id];
    const owner = findWorkspanBySession(state.workspans, id);
    const ownerIndex = owner ? state.workspans.findIndex((workspan) => workspan.id === owner.id) : -1;
    const workspans = removeSessionFromTerminalWorkspans(state.workspans, id);
    const ownerStillExists = owner ? workspans.some((workspan) => workspan.id === owner.id) : false;
    let activeWorkspanId = state.activeWorkspanId;
    if (owner?.id === state.activeWorkspanId && !ownerStillExists) {
      activeWorkspanId = workspans[Math.min(Math.max(ownerIndex, 0), Math.max(workspans.length - 1, 0))]?.id ?? null;
    }
    const mirror = buildWorkspanMirror(workspans, activeWorkspanId);

    delete newStatuses[id];
    delete newListeners[id];
    delete newNotifications[id];
    delete newTabStatuses[id];
    delete newTabStatusDetails[id];

    // Drop in-memory background overrides for closed sessions (R8).
    const prevHidden = state.hiddenBackgroundSessionIds;
    let newHidden = prevHidden;
    if (prevHidden.has(id)) {
      newHidden = new Set(prevHidden);
      newHidden.delete(id);
    }
    const newDaemonAttachPending = new Set(state.daemonAttachPendingSessionIds);
    newDaemonAttachPending.delete(id);

    state.statusListeners[id]?.();

    set({
      sessions: remaining,
      ...mirror,
      sessionStatuses: newStatuses,
      statusListeners: newListeners,
      tabNotifications: newNotifications,
      tabStatuses: newTabStatuses,
      tabStatusDetails: newTabStatusDetails,
      subagentTranscripts: newSubagentTranscripts,
      splits: {},
      daemonAttachPendingSessionIds: newDaemonAttachPending,
      ...(newHidden !== prevHidden ? { hiddenBackgroundSessionIds: newHidden } : {}),
    });

    try {
      await useSessionStore.getState().saveSessions(remaining);
      const nextActiveSession = mirror.activeSessionId ? remaining.find((session) => session.id === mirror.activeSessionId) : undefined;
      await useSessionStore.getState().saveActiveSessionId(isPersistableSession(nextActiveSession) ? mirror.activeSessionId : null);
      await useSessionStore.getState().saveWorkspans(workspans, mirror.activeWorkspanId, remaining);

      // 更新 splits（移除已关闭主会话对应的 split），使用关闭前记录的索引
      if (closedIndex >= 0) {
        const persistedSplits = useSessionStore.getState().splits.filter(
          (s) => s.primarySessionIndex !== closedIndex
        );
        await useSessionStore.getState().saveSplits(persistedSplits);
      }
    } finally {
      if (isFileEditor) {
        return;
      }
      if (isTranscript) {
        void invoke("subagent_transcript_unsubscribe", { key: id }).catch((err) => {
          logError("subagent_transcript_unsubscribe failed while closing tab", { key: id, err });
        });
      } else {
        for (const sessionId of ptySessionIds) {
          void terminalProcessManager.close(sessionId).catch((err) => {
            logError("PtyHost close failed while closing terminal tab", { sessionId, err });
          });
        }
      }
    }
  },

  setActive: (id) => {
    const state = get();
    const owner = findWorkspanBySession(state.workspans, id);
    if (!owner) return;
    const paneResult = setPaneActiveSession(owner.paneTree, id);
    const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId ?? workspan.activePaneId, id)
    ));
    const mirror = buildWorkspanMirror(workspans, owner.id);
    set(mirror);
    scheduleSaveActiveId(id);
    persistWorkspanState(workspans, owner.id, state.sessions);
  },

  setWorkspanModeEnabled: (enabled) => {
    const state = get();
    const workspans = enabled
      ? state.workspans
      : collapseTerminalWorkspansToLegacy(state.workspans, state.activeWorkspanId, createPaneId);
    const activeWorkspanId = enabled
      ? state.activeWorkspanId
      : workspans[0]?.id ?? null;
    const mirror = buildWorkspanMirror(workspans, activeWorkspanId);
    set({ ...mirror, splits: {} });
    scheduleSaveActiveId(mirror.activeSessionId);
    persistWorkspanState(workspans, mirror.activeWorkspanId, state.sessions);
  },

  setActiveWorkspan: (id) => {
    const state = get();
    if (!state.workspans.some((workspan) => workspan.id === id)) return;
    const mirror = buildWorkspanMirror(state.workspans, id);
    set(mirror);
    scheduleSaveActiveId(mirror.activeSessionId);
    persistWorkspanState(state.workspans, id, state.sessions);
  },

  reorderWorkspans: (fromId, toId) => {
    const state = get();
    const workspans = reorderTerminalWorkspans(state.workspans, fromId, toId);
    if (workspans === state.workspans) return;
    set({ workspans });
    persistWorkspanState(workspans, state.activeWorkspanId, state.sessions);
  },

  renameWorkspan: (id, title) => {
    const state = get();
    const customTitle = title.trim() || null;
    const current = state.workspans.find((workspan) => workspan.id === id);
    if (!current || current.customTitle === customTitle) return;
    const workspans = updateTerminalWorkspan(state.workspans, id, (workspan) => ({ ...workspan, customTitle }));
    set({ workspans });
    persistWorkspanState(workspans, state.activeWorkspanId, state.sessions);
  },

  mergeWorkspanAtPaneEdge: (sourceId, targetId, targetPaneId, edge) => {
    const state = get();
    const result = mergeTerminalWorkspansAtPaneEdge(
      state.workspans,
      sourceId,
      targetId,
      targetPaneId,
      edge,
      createPaneId
    );
    if (!result.changed) return;
    const mirror = buildWorkspanMirror(result.workspans, result.activeWorkspanId);
    set({ ...mirror, splits: {} });
    scheduleSaveActiveId(mirror.activeSessionId);
    persistWorkspanState(result.workspans, result.activeWorkspanId, state.sessions);
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
    const cliReasoningEffort = payload.reasoningEffort?.trim();
    if ((cliSessionId || cliReasoningEffort) && get().sessions.some((session) => session.id === rawTabId)) {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === rawTabId
            ? {
                ...session,
                ...(cliSessionId && session.cliSessionId !== cliSessionId ? { cliSessionId } : {}),
                ...(cliReasoningEffort && session.cliReasoningEffort !== cliReasoningEffort
                  ? { cliReasoningEffort }
                  : {}),
              }
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
    const state = get();
    const owner = findWorkspanBySession(state.workspans, fromId);
    const pane = owner ? findPaneLeafBySession(owner.paneTree, fromId) : null;
    if (!pane || !pane.sessionIds.includes(toId)) return;
    const nextTree = reorderSessionInPane(owner!.paneTree, pane.id, fromId, toId);
    const workspans = updateTerminalWorkspan(state.workspans, owner!.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, nextTree, pane.id, fromId)
    ));
    set(buildWorkspanMirror(workspans, owner!.id));
    scheduleSaveActiveId(fromId);
    persistWorkspanState(workspans, owner!.id, state.sessions);
  },

  moveSessionToPane: (sessionId, targetPaneId, beforeSessionId) => {
    const state = get();
    const owner = findWorkspanBySession(state.workspans, sessionId);
    const targetOwner = findWorkspanByPane(state.workspans, targetPaneId);
    if (!owner || owner.id !== targetOwner?.id) return;
    const sourcePane = findPaneLeafBySession(owner.paneTree, sessionId);
    const targetPane = findPaneLeaf(owner.paneTree, targetPaneId);
    if (!sourcePane || !targetPane || sourcePane.id === targetPane.id) return;
    const result = moveSessionToPaneTree(owner.paneTree, sourcePane.id, targetPane.id, sessionId, beforeSessionId);
    const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, result.tree, result.activePaneId, sessionId)
    ));
    set(buildWorkspanMirror(workspans, owner.id));
    scheduleSaveActiveId(sessionId);
    persistWorkspanState(workspans, owner.id, state.sessions);
  },

  splitSessionToPaneEdge: (sessionId, targetPaneId, edge) => {
    const state = get();
    const owner = findWorkspanBySession(state.workspans, sessionId);
    if (!owner || owner.id !== findWorkspanByPane(state.workspans, targetPaneId)?.id) return;
    const result = splitExistingSessionToPaneEdge(owner.paneTree, sessionId, targetPaneId, edge, createPaneId);
    if (!result.changed) return;
    const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, result.tree, result.activePaneId, result.activeSessionId)
    ));
    set({ ...buildWorkspanMirror(workspans, owner.id), splits: {} });
    scheduleSaveActiveId(result.activeSessionId);
    persistWorkspanState(workspans, owner.id, state.sessions);
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

  splitPaneEmpty: (paneId, direction) => {
    const state = get();
    const owner = findWorkspanByPane(state.workspans, paneId);
    if (!owner?.paneTree) return;
    const result = splitPaneEmptyTree(owner.paneTree, paneId, direction, createPaneId);
    const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, result.tree, result.activePaneId, workspan.activeSessionId)
    ));
    set(buildWorkspanMirror(workspans, owner.id));
  },

  splitTerminal: async (sessionId, direction, options) => {
    const initialState = get();
    const owner = findWorkspanBySession(initialState.workspans, sessionId);
    const targetPane = owner ? findPaneLeafBySession(owner.paneTree, sessionId) : null;
    if (!targetPane || !owner?.paneTree) return null;

    const os = await getOsPlatform();
    const resolvedShell = resolveShellForPty(options?.shell, !!options?.projectId, os);
    const launchStartupCmd = prepareStartupCommandForPty(options?.startupCmd, normalizeShellKey(resolvedShell) ?? null);

    let splitSessionId: string;
    try {
      splitSessionId = await terminalProcessManager.create({
        cwd: options?.cwd ?? null,
        envVars: buildPtyEnvVars(options?.envVars ?? null, resolvedShell),
        shell: resolvedShell,
        hookEnvEnabled: await shouldEnableHookEnv(),
        claudeProvider: getClaudeProviderLaunchConfig(options?.projectId, options?.worktreeId),
        codexProvider: getCodexProviderLaunchConfig(options?.projectId, options?.startupCmd, options?.worktreeId),
      });
    } catch (err) {
      const description = formatTerminalCreateError(err);
      toast.error(translateCurrent("terminal.toast.splitCreateFailed"), { description });
      logError("PtyHost create failed for split terminal", {
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
      worktreeId: options?.worktreeId,
      title: createSplitSessionTitle(options),
      cwd: options?.cwd,
      shell: resolvedShell,
      envVars: options?.envVars,
      startupCmd: options?.startupCmd,
    };

    const unlisten = await terminalProcessManager.subscribeStatus(splitSessionId, (payload) => {
      const status = payload.status as SessionStatus;
      logTerminalExitStatus(splitSession, payload);
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, [splitSessionId]: status },
      }));
    });

    const currentState = get();
    const currentOwner = findWorkspanBySession(currentState.workspans, sessionId);
    const currentTargetPane = currentOwner ? findPaneLeafBySession(currentOwner.paneTree, sessionId) : null;
    if (!currentOwner?.paneTree || !currentTargetPane) {
      unlisten();
      await terminalProcessManager.close(splitSessionId).catch((err) => {
        logError("PtyHost close failed for abandoned split terminal", { sessionId: splitSessionId, err });
      });
      return null;
    }

    const paneResult = splitPaneLeaf(currentOwner.paneTree, currentTargetPane.id, direction, splitSessionId, createPaneId);
    const newSessions = [...currentState.sessions, splitSession];
    const workspans = updateTerminalWorkspan(currentState.workspans, currentOwner.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId, splitSessionId)
    ));
    set((state) => ({
      sessions: newSessions,
      ...buildWorkspanMirror(workspans, currentOwner.id),
      splits: {},
      sessionStatuses: { ...state.sessionStatuses, [splitSessionId]: "running" },
      statusListeners: { ...state.statusListeners, [splitSessionId]: unlisten },
    }));

    await useSessionStore.getState().saveSessions(newSessions);
    await useSessionStore.getState().saveActiveSessionId(splitSessionId);
    await useSessionStore.getState().saveSplits([]);
    await useSessionStore.getState().saveWorkspans(workspans, currentOwner.id, newSessions);

    if (launchStartupCmd) {
      setTimeout(() => {
        terminalProcessManager.write(splitSessionId, formatStartupInputForPty(launchStartupCmd, normalizeShellKey(resolvedShell) ?? null)).catch((err) => {
          toast.error("启动命令写入失败", { description: String(err) });
          logError("Failed to write split startup command", {
            sessionId: splitSessionId,
            hasStartupCmd: true,
            startupCmdSummary: summarizeStartupCmd(launchStartupCmd),
            err,
          });
        });
      }, 500);
    }

    return splitSessionId;
  },

  openFileEditorPane: (project) => {
    const editorSessionId = createFileEditorSessionId(project.id);
    const existing = get().sessions.find((session) => session.id === editorSessionId);
    if (existing) {
      get().setActive(editorSessionId);
      return editorSessionId;
    }

    const editorSession: TerminalSession = {
      id: editorSessionId,
      projectId: project.id,
      title: `文件：${project.name}`,
      kind: "file-editor",
      fileEditor: {
        projectId: project.id,
        projectPath: project.path,
        projectName: project.name,
        project,
      },
    };
    const state = get();
    const sessions = [...state.sessions, editorSession];
    const workspanEnabled = useSettingsStore.getState().workspanEnabled;
    const targetWorkspan = !workspanEnabled
      ? state.workspans.find((workspan) => workspan.id === state.activeWorkspanId) ?? state.workspans[0] ?? null
      : null;
    let workspans: TerminalWorkspan[];
    let activeWorkspanId: string;
    if (targetWorkspan) {
      const paneResult = addSessionToPaneTree(targetWorkspan.paneTree, targetWorkspan.activePaneId, editorSessionId, createPaneId);
      workspans = updateTerminalWorkspan(state.workspans, targetWorkspan.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId, editorSessionId)
      ));
      activeWorkspanId = targetWorkspan.id;
    } else {
      const workspan = createTerminalWorkspan(createWorkspanId(), createPaneId(), editorSessionId);
      workspans = [...state.workspans, workspan];
      activeWorkspanId = workspan.id;
    }

    set({
      sessions,
      ...buildWorkspanMirror(workspans, activeWorkspanId),
      splits: {},
    });
    void useSessionStore.getState().saveSessions(sessions).catch(() => {});
    persistWorkspanState(workspans, activeWorkspanId, sessions);
    return editorSessionId;
  },

  openSyncedHistoryPane: async (group, project) => {
    const firstSession = group.sessions[0];
    if (!firstSession) {
      throw new Error("同步记录为空。");
    }
    const label = firstSession?.source === "codex" ? "Codex" : "Claude";
    const existing = get().sessions.find(
      (session) => session.kind === "synced-history" && session.syncedHistory?.key === group.key && get().sessionStatuses[session.id]
    );
    if (existing) {
      get().setActive(existing.id);
      return existing.id;
    }

    const sortedSessions = [...group.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    const latestSession = sortedSessions[0];
    const cwd = latestSession?.cwd || group.cwd || project?.path;
    const shell = project?.shell && project.shell !== "powershell" ? project.shell : undefined;
    const startupCmd = await appendSyncedHistoryContextArg(sourceTool(firstSession.source), sourceTool(firstSession.source), group, shell);
    const envVars = project ? parseProjectEnvVars(project) : undefined;
    const launch = await createDetachedPtyProcess({
      projectId: project?.id,
      cwd,
      startupCmd,
      envVars,
      shell,
    });
    const historySession: TerminalSession = {
      id: launch.sessionId,
      projectId: project?.id,
      title: `${group.name} · ${label} 同步终端`,
      cwd,
      shell: launch.shell,
      envVars,
      startupCmd: launch.startupCmd ?? startupCmd,
      kind: "synced-history",
      syncedHistory: {
        key: group.key,
        title: group.name,
        cwd: group.cwd || project?.path || "",
        sessions: group.sessions.map((session) => ({
          key: session.key,
          source: session.source,
          sessionId: session.sessionId,
          projectKey: session.projectKey,
          filePath: session.filePath,
          projectName: session.projectName,
          cwd: session.cwd,
          title: session.title,
          startupCmd: session.startupCmd,
          updatedAt: session.updatedAt,
        })),
      },
    };
    const unlisten = await terminalProcessManager.subscribeStatus(launch.sessionId, (payload) => {
      const status = payload.status as SessionStatus;
      logTerminalExitStatus(historySession, payload);
      set((state) => ({
        sessionStatuses: { ...state.sessionStatuses, [launch.sessionId]: status },
      }));
    });
    const state = get();
    const sessions = [...state.sessions, historySession];
    const activeWorkspan = state.workspans.find((workspan) => workspan.id === state.activeWorkspanId) ?? null;
    let workspans: TerminalWorkspan[];
    let activeWorkspanId: string;
    if (activeWorkspan?.paneTree) {
      const paneResult = addSessionToPaneTree(activeWorkspan.paneTree, activeWorkspan.activePaneId, launch.sessionId, createPaneId);
      workspans = updateTerminalWorkspan(state.workspans, activeWorkspan.id, (workspan) => (
        syncTerminalWorkspanLayout(workspan, paneResult.tree, paneResult.activePaneId, launch.sessionId)
      ));
      activeWorkspanId = activeWorkspan.id;
    } else {
      const workspan = createTerminalWorkspan(createWorkspanId(), createPaneId(), launch.sessionId);
      workspans = [...state.workspans, workspan];
      activeWorkspanId = workspan.id;
    }

    set({
      sessions,
      ...buildWorkspanMirror(workspans, activeWorkspanId),
      sessionStatuses: { ...state.sessionStatuses, [launch.sessionId]: "running" },
      statusListeners: { ...state.statusListeners, [launch.sessionId]: unlisten },
      splits: {},
    });
    void useSessionStore.getState().saveSessions(sessions).catch(() => {});
    void useSessionStore.getState().saveActiveSessionId(null).catch(() => {});
    persistWorkspanState(workspans, activeWorkspanId, sessions);
    return launch.sessionId;
  },

  unsplitTerminal: async (sessionId) => {
    const state = get();
    const owner = findWorkspanBySession(state.workspans, sessionId);
    const pane = owner ? findPaneLeafBySession(owner.paneTree, sessionId) : null;
    if (!pane || !owner) return;
    const behavior = useSettingsStore.getState().unsplitBehavior;
    const result = unsplitPaneLeaf(owner.paneTree, pane.id, behavior);
    const closedSessionIds = result.closedSessionIds;
    const transcriptClosedIds = new Set(
      state.sessions
        .filter((s) => closedSessionIds.includes(s.id) && s.kind === "subagent-transcript")
        .map((s) => s.id)
    );
    const fileEditorClosedIds = new Set(
      state.sessions
        .filter((s) => closedSessionIds.includes(s.id) && s.kind === "file-editor")
        .map((s) => s.id)
    );
    for (const closedSessionId of closedSessionIds) {
      if (transcriptClosedIds.has(closedSessionId)) {
        stopSubagentTranscriptRetry(closedSessionId, "pane_unsplit");
      }
      state.statusListeners[closedSessionId]?.();
    }

    const newStatuses = { ...state.sessionStatuses };
    const newListeners = { ...state.statusListeners };
    const newNotifications = { ...state.tabNotifications };
    const newTabStatuses = { ...state.tabStatuses };
    const newTabStatusDetails = { ...state.tabStatusDetails };
    const newSubagentTranscripts = { ...state.subagentTranscripts };
    const newHidden = new Set(state.hiddenBackgroundSessionIds);
    const newDaemonAttachPending = new Set(state.daemonAttachPendingSessionIds);
    for (const closedSessionId of closedSessionIds) {
      delete newStatuses[closedSessionId];
      delete newListeners[closedSessionId];
      delete newNotifications[closedSessionId];
      delete newTabStatuses[closedSessionId];
      delete newTabStatusDetails[closedSessionId];
      delete newSubagentTranscripts[closedSessionId];
      newHidden.delete(closedSessionId);
      newDaemonAttachPending.delete(closedSessionId);
    }

    const closedSet = new Set(closedSessionIds);
    const remaining = state.sessions.filter((session) => !closedSet.has(session.id));
    const workspans = updateTerminalWorkspan(state.workspans, owner.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, result.tree, result.activePaneId, result.activeSessionId)
    ));
    const mirror = buildWorkspanMirror(workspans, owner.id);
    set({
      sessions: remaining,
      ...mirror,
      sessionStatuses: newStatuses,
      statusListeners: newListeners,
      tabNotifications: newNotifications,
      tabStatuses: newTabStatuses,
      tabStatusDetails: newTabStatusDetails,
      splits: {},
      hiddenBackgroundSessionIds: newHidden,
      daemonAttachPendingSessionIds: newDaemonAttachPending,
      subagentTranscripts: newSubagentTranscripts,
    });

    await useSessionStore.getState().saveSessions(remaining);
    const nextActiveSession = mirror.activeSessionId
      ? remaining.find((session) => session.id === mirror.activeSessionId)
      : undefined;
    await useSessionStore.getState().saveActiveSessionId(
      isPersistableSession(nextActiveSession) ? mirror.activeSessionId : null
    );
    await useSessionStore.getState().saveSplits([]);
    await useSessionStore.getState().saveWorkspans(workspans, mirror.activeWorkspanId, remaining);

    for (const closedSessionId of closedSessionIds) {
      if (fileEditorClosedIds.has(closedSessionId)) {
        continue;
      }
      if (transcriptClosedIds.has(closedSessionId)) {
        void invoke("subagent_transcript_unsubscribe", { key: closedSessionId }).catch((err) => {
          logError("subagent_transcript_unsubscribe failed while unsplitting pane", { key: closedSessionId, err });
        });
      } else {
        void terminalProcessManager.close(closedSessionId).catch((err) => {
          logError("PtyHost close failed while unsplitting pane", { sessionId: closedSessionId, err });
        });
      }
    }
  },

  setSplitRatio: (splitId, ratio) => {
    const state = get();
    const activeWorkspan = state.workspans.find((workspan) => workspan.id === state.activeWorkspanId);
    if (!activeWorkspan) return;
    const paneTree = resizePaneSplit(activeWorkspan.paneTree, splitId, ratio);
    const workspans = updateTerminalWorkspan(state.workspans, activeWorkspan.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, paneTree, workspan.activePaneId, workspan.activeSessionId)
    ));
    set(buildWorkspanMirror(workspans, activeWorkspan.id));
    persistWorkspanState(workspans, activeWorkspan.id, state.sessions);
  },

  getNextSessionIdForShortcut: (delta) => {
    const state = get();
    const nextSessionId = resolveNextSessionIdForShortcut(
      state.paneTree,
      state.activePaneId,
      state.activeSessionId,
      delta
    );
    if (nextSessionId && nextSessionId !== state.activeSessionId) return nextSessionId;
    return getAdjacentWorkspanSessionId(state.workspans, state.activeWorkspanId, delta);
  },

  restoreSessions: async (projectMap, projectHealth) => {
    // 防止 StrictMode 双重调用
    if (restoreInProgress) return;
    restoreInProgress = true;

    try {
      const sessionStore = useSessionStore.getState();
      const persistedSessions = sessionStore.sessions;
      const persistedActiveId = sessionStore.activeSessionId;
      const persistedWorkspans = sessionStore.workspans;
      const persistedActiveWorkspanId = sessionStore.activeWorkspanId;

      if (persistedSessions.length === 0) return;

    const restoredSessions: TerminalSession[] = [];
    const restoredStatuses: Record<string, SessionStatus> = {};
    const restoredListeners: Record<string, UnlistenFn> = {};
    const daemonAttachPendingSessionIds = new Set<string>();
    let restoredTabState: Pick<TerminalStore, "tabStatuses" | "tabNotifications" | "tabStatusDetails"> = {
      tabStatuses: {},
      tabNotifications: {},
      tabStatusDetails: {},
    };
    const skippedSessions: string[] = [];

    const newIdMap: Record<string, string> = {}; // oldId -> newId

    // Phase 2（Issue #123）：daemon 仍存活的会话优先 attach 续用——真后台续跑归来，
    // 不重建 PTY、不 resume。daemon 不可用/查询失败 → 空集合，全部走重建兜底。
    let daemonSessionsById = new Map<string, DaemonSessionMeta>();
    try {
      const daemonSessions = await invoke<DaemonSessionMeta[]>(
        "pty_daemon_sessions"
      );
      daemonSessionsById = new Map(
        daemonSessions.filter((session) => session.alive).map((session) => [session.sessionId, session])
      );
    } catch (err) {
      logInfo("pty daemon sessions unavailable, restoring via recreate", { err });
    }

    const os = await getOsPlatform();
    for (let i = 0; i < persistedSessions.length; i++) {
      const ps = persistedSessions[i];
      if (isCliManagerSyncArtifactText(ps.title ?? "") || isCliManagerSyncArtifactText(ps.startupCmd ?? "")) {
        skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
        continue;
      }

      // daemon 会话仍存活时先恢复 UI 元数据。实际 attach 等 XTerm 输出监听就绪后执行。
      const daemonSession = daemonSessionsById.get(ps.id);
      if (daemonSession) {
        try {
          if (daemonSession.alive) {
            const taskStatus = resolveDaemonAttachTaskStatus(daemonSession);
            const taskUpdatedAt = resolveDaemonAttachUpdatedAt(daemonSession);
            const attachedMeta = resolveAttachedDaemonSession(ps, daemonSession);
            const attachedSession: TerminalSession = {
              id: ps.id,
              projectId: attachedMeta.projectId,
              worktreeId: attachedMeta.worktreeId,
              title: attachedMeta.title,
              cwd: attachedMeta.cwd,
              shell: attachedMeta.shell,
              envVars: ps.envVars,
              // 仅保留给 Tab 厂商识别；daemon attach 不会重新执行该命令。
              startupCmd: ps.startupCmd,
              cliSessionId: ps.cliSessionId,
              deferStartupUntilInitialOutput: false,
            };
            const unlisten = await terminalProcessManager.subscribeStatus(ps.id, (payload) => {
              const status = payload.status as SessionStatus;
              logTerminalExitStatus(attachedSession, payload);
              useTerminalStore.setState((state) => {
                const sessionStatuses = { ...state.sessionStatuses, [ps.id]: status };
                if (status === "running") return { sessionStatuses };
                return {
                  sessionStatuses,
                  ...buildTabStatusUpdate(
                    state,
                    ps.id,
                    "hook",
                    status === "error" ? "failed" : "done",
                    new Date().toISOString()
                  ),
                };
              });
            });
            newIdMap[ps.id] = ps.id;
            restoredSessions.push(attachedSession);
            restoredStatuses[ps.id] = "running";
            restoredListeners[ps.id] = unlisten;
            daemonAttachPendingSessionIds.add(ps.id);
            restoredTabState = buildTabStatusUpdate(restoredTabState, ps.id, "hook", taskStatus, taskUpdatedAt);
            continue;
          }
        } catch (err) {
          logError("daemon attach failed, falling back to recreate", { sessionId: ps.id, err });
        }
      }

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
      const resolvedShell = resolveShellForPty(ps.shell, !!ps.projectId, os);

      let newSessionId: string;
      try {
        newSessionId = await terminalProcessManager.create({
          cwd: ps.cwd ?? null,
          envVars: buildPtyEnvVars(ps.envVars ?? null, resolvedShell),
          shell: resolvedShell,
          hookEnvEnabled: await shouldEnableHookEnv(),
          claudeProvider: getClaudeProviderLaunchConfig(ps.projectId, ps.worktreeId),
          codexProvider: getCodexProviderLaunchConfig(ps.projectId, ps.startupCmd, ps.worktreeId),
        });
      } catch (err) {
        logError("Failed to restore session", { session: ps, err });
        skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
        continue;
      }

      newIdMap[ps.id] = newSessionId;

      const shellKey = normalizeShellKey(resolvedShell) ?? null;
      // 恢复按会话类型分流：CLI 会话（codex/claude）走原生 resume，普通 shell 会话静态贴回 scrollback。
      const restoreProject = ps.projectId ? projectMap.get(ps.projectId) : undefined;
      const cliKind = detectCliResumeKind(ps.startupCmd, restoreProject);

      let launchStartupCmd: string | undefined;
      let initialTerminalOutput: string | undefined;
      let deferStartupUntilInitialOutput = false;

      if (cliKind) {
        // CLI 会话：不贴 initialTerminalOutput（TUI 绝对定位重绘会盖掉它，见
        // research/tui-startup-clear-sequences.md），改用 resume 让 CLI 自己重画上次对话并可继续。
        const resumeCmd = buildCliResumeStartupCommand(cliKind, ps.cliSessionId, restoreProject);
        launchStartupCmd = prepareStartupCommandForPty(resumeCmd, shellKey);
      } else {
        // 普通 shell 会话：静态贴回历史滚动内容（shell 不清屏，历史可见），startupCmd 保持首轮行为。
        const restoredStartupCmd = normalizeDirectCodexStartupCommand(ps.startupCmd);
        launchStartupCmd = prepareStartupCommandForPty(restoredStartupCmd, shellKey);
        initialTerminalOutput = ps.initialTerminalOutput;
        // 有历史画面时：先静态贴回 initialTerminalOutput，再由 XTermTerminal 在贴回完成后重放 startupCmd，
        // 避免"setTimeout 写入"与"贴回大段文本"竞态导致启动命令淹没在历史输出里。
        deferStartupUntilInitialOutput = !!ps.initialTerminalOutput && !!launchStartupCmd;
      }

      const hasInitialOutput = !!initialTerminalOutput;
      const restoredSession: TerminalSession = {
        id: newSessionId,
        projectId: ps.projectId,
        worktreeId: ps.worktreeId,
        title: ps.title,
        cwd: ps.cwd,
        shell: resolvedShell,
        envVars: ps.envVars,
        startupCmd: launchStartupCmd,
        // 保留 cliSessionId：hook 上报会用它绑定实时统计；下次落盘也需要它继续 resume。
        cliSessionId: ps.cliSessionId,
        initialTerminalOutput,
        deferStartupUntilInitialOutput,
      };

      let unlisten: UnlistenFn;
      try {
        unlisten = await terminalProcessManager.subscribeStatus(newSessionId, (payload) => {
          const status = payload.status as SessionStatus;
          logTerminalExitStatus(restoredSession, payload);
          useTerminalStore.setState((state) => ({
            sessionStatuses: { ...state.sessionStatuses, [newSessionId]: status },
          }));
        });
      } catch (err) {
        logError("Failed to register status listener", { sessionId: newSessionId, err });
        await terminalProcessManager.close(newSessionId).catch(() => {});
        skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
        continue;
      }

      restoredSessions.push(restoredSession);
      restoredStatuses[newSessionId] = "running";
      restoredListeners[newSessionId] = unlisten;

      // 执行启动命令：CLI resume 命令 / 无历史画面的普通命令走这里直接写入；
      // 有历史画面时（仅 shell 分支）改由 XTermTerminal 在贴回完成后重放（deferStartupUntilInitialOutput），
      // 这里不再 setTimeout 写入，避免同一条 startupCmd 被执行两次。
      if (launchStartupCmd && !hasInitialOutput) {
        setTimeout(() => {
          terminalProcessManager.write(newSessionId, formatStartupInputForPty(launchStartupCmd!, shellKey)).catch((err) => {
            logError("Failed to write startup command on restore", {
              sessionId: newSessionId,
              hasStartupCmd: true,
              startupCmdSummary: summarizeStartupCmd(launchStartupCmd!),
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

    const restoredSessionIds = new Set(restoredSessions.map((session) => session.id));
    let workspans = sanitizeTerminalWorkspans(
      restoreTerminalWorkspans(persistedWorkspans, newIdMap),
      restoredSessionIds
    );
    const assignedSessionIds = new Set(workspans.flatMap(collectWorkspanSessionIds));
    for (const session of restoredSessions) {
      if (assignedSessionIds.has(session.id)) continue;
      workspans.push(createTerminalWorkspan(createWorkspanId(), createPaneId(), session.id));
      assignedSessionIds.add(session.id);
    }
    let activeWorkspanId = persistedActiveWorkspanId
      && workspans.some((workspan) => workspan.id === persistedActiveWorkspanId)
      ? persistedActiveWorkspanId
      : newActiveId
        ? findWorkspanBySession(workspans, newActiveId)?.id ?? workspans[workspans.length - 1]?.id ?? null
        : workspans[workspans.length - 1]?.id ?? null;
    if (!useSettingsStore.getState().workspanEnabled) {
      workspans = collapseTerminalWorkspansToLegacy(workspans, activeWorkspanId, createPaneId);
      activeWorkspanId = workspans[0]?.id ?? null;
    }
    const mirror = buildWorkspanMirror(workspans, activeWorkspanId);

	    set({
	      sessions: restoredSessions,
	      ...mirror,
	      sessionStatuses: restoredStatuses,
	      statusListeners: restoredListeners,
	      daemonAttachPendingSessionIds,
	      ...restoredTabState,
	      splits: {},
	    });

    // 更新 sessionStore 的持久化数据（使用新 ID）
    const updatedPersistedSessions = restoredSessions.map((s) => ({
      ...s,
      id: s.id, // 已经是新 ID
    }));
    await sessionStore.saveSessions(updatedPersistedSessions);
    await sessionStore.saveSplits([]);
    await sessionStore.saveActiveSessionId(mirror.activeSessionId);
    await sessionStore.saveWorkspans(workspans, mirror.activeWorkspanId, updatedPersistedSessions);

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

  attachDaemonSession: async (sessionId) => {
    const current = get();
    if (current.sessions.some((session) => session.id === sessionId)) {
      current.setActive(sessionId);
      return true;
    }

    const persisted = useSessionStore.getState().sessions.find((session) => session.id === sessionId);
    const daemonSession = (await invoke<DaemonSessionMeta[]>("pty_daemon_sessions"))
      .find((item) => item.sessionId === sessionId);
    if (!daemonSession) return false;

    const taskStatus = resolveDaemonAttachTaskStatus(daemonSession);
    const taskUpdatedAt = resolveDaemonAttachUpdatedAt(daemonSession);
    const attachedMeta = resolveAttachedDaemonSession(persisted, daemonSession);
    const session: TerminalSession = {
      id: sessionId,
      projectId: attachedMeta.projectId,
      worktreeId: attachedMeta.worktreeId,
      title: attachedMeta.title,
      cwd: attachedMeta.cwd,
      shell: attachedMeta.shell,
      envVars: persisted?.envVars,
      // 元数据用于 Tab 厂商识别；daemon attach 不会重新执行该命令。
      startupCmd: persisted?.startupCmd,
      cliSessionId: persisted?.cliSessionId,
      deferStartupUntilInitialOutput: false,
    };
    const unlisten = await terminalProcessManager.subscribeStatus(sessionId, (payload) => {
      const status = payload.status as SessionStatus;
      useTerminalStore.setState((state) => {
        const sessionStatuses = { ...state.sessionStatuses, [sessionId]: status };
        if (status === "running") return { sessionStatuses };
        return {
          sessionStatuses,
          ...buildTabStatusUpdate(
            state,
            sessionId,
            "hook",
            status === "error" ? "failed" : "done",
            new Date().toISOString()
          ),
        };
      });
    });

    const nextSessions = [...current.sessions, session];
    const nextWorkspan = createTerminalWorkspan(createWorkspanId(), createPaneId(), sessionId);
    const workspans = [...current.workspans, nextWorkspan];
    const mirror = buildWorkspanMirror(workspans, nextWorkspan.id);
    const initialTabState = buildTabStatusUpdate(
      current,
      sessionId,
      "hook",
      taskStatus,
      taskUpdatedAt
    );
    set({
      sessions: nextSessions,
      ...mirror,
      sessionStatuses: {
        ...current.sessionStatuses,
        [sessionId]: daemonSession.alive ? "running" : "exited",
      },
      statusListeners: { ...current.statusListeners, [sessionId]: unlisten },
      daemonAttachPendingSessionIds: new Set([
        ...current.daemonAttachPendingSessionIds,
        sessionId,
      ]),
      ...initialTabState,
    });
    await useSessionStore.getState().saveSessions(nextSessions);
    await useSessionStore.getState().saveActiveSessionId(sessionId);
    await useSessionStore.getState().saveWorkspans(workspans, nextWorkspan.id, nextSessions);
    return true;
  },

  discardDaemonSession: async (sessionId) => {
    if (get().sessions.some((session) => session.id === sessionId)) {
      await get().closeSession(sessionId);
      return;
    }
    await terminalProcessManager.close(sessionId).catch((err) => {
      logWarn("daemon session was already unavailable while discarding", { sessionId, err });
    });
    const persisted = useSessionStore.getState();
    const sessions = persisted.sessions.filter((session) => session.id !== sessionId);
    const workspans = removeSessionFromTerminalWorkspans(persisted.workspans, sessionId);
    const activeWorkspanId = persisted.activeWorkspanId
      && workspans.some((workspan) => workspan.id === persisted.activeWorkspanId)
      ? persisted.activeWorkspanId
      : workspans[0]?.id ?? null;
    await persisted.saveSessions(sessions);
    await persisted.saveActiveSessionId(
      persisted.activeSessionId === sessionId ? null : persisted.activeSessionId
    );
    await persisted.saveWorkspans(workspans, activeWorkspanId, sessions);
  },

  getRunningTaskSessionIds: () => {
    const state = get();
    return state.sessions
      .filter(
        (session) =>
          (!session.kind || session.kind === "pty") &&
          state.sessionStatuses[session.id] === "running" &&
          state.tabNotifications[session.id] === "running"
      )
      .map((session) => session.id);
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

  openSubagentTranscript: async (payload) => {
    const parentTabId = payload.tabId;
    const sessions = get().sessions;
    // 多窗口隔离：hook 事件广播到所有窗口，仅拥有该 Tab 的窗口处理。
    if (!sessions.some((session) => session.id === parentTabId)) {
      logInfo("[subagent_transcript] parent tab not found, skipping", {
        parentTabId,
        event: payload.event,
        agentId: payload.agentId,
        sessionCount: sessions.length,
        sessionIds: sessions.map((s) => s.id).slice(0, 5),
      });
      return;
    }

    const parentWorkspan = findWorkspanBySession(get().workspans, parentTabId);
    const tree = parentWorkspan?.paneTree ?? null;
    if (!tree || !parentWorkspan) return;

    const agentId = trimOptional(payload.agentId);
    const toolUseId = trimOptional(payload.toolUseId);
    const resolvedWslDistroName = resolveHookWslDistroName(payload);
    const resolvedSource = resolveSubagentTranscriptSource(payload);
    const existingSessionId = findSubagentSessionId(sessions, payload);
    const pseudoId = existingSessionId ?? createSubagentPaneId(parentTabId, agentId, toolUseId, resolvedSource.kind === "child-jsonl" ? resolvedSource.transcriptPath ?? null : null);
    const previousSource = get().subagentTranscripts[pseudoId]?.source;
    const source = mergeSubagentSource(previousSource, resolvedSource);
    const shouldSubscribe = shouldSubscribeSubagentSource(previousSource, source);
    const splitViewEnabled = useSettingsStore.getState().hookSubagentSplitViewEnabled;

    logInfo("[subagent_transcript] source resolved", {
      event: payload.event,
      pseudoId,
      agentId,
      toolUseId,
      sessionId: payload.sessionId ?? null,
      cwd: payload.cwd ?? null,
      wslDistroName: resolvedWslDistroName,
      payloadWslDistroName: trimOptional(payload.wslDistroName),
      inferredWslDistroName: inferWslDistroFromCwd(payload.cwd),
      sourceKind: source.kind,
      transcriptPath: source.transcriptPath ?? null,
      parentTranscriptPath: source.parentTranscriptPath ?? null,
      hasAgentTranscriptPath: Boolean(trimOptional(payload.agentTranscriptPath)),
      hasParentTranscriptPath: Boolean(trimOptional(payload.transcriptPath)),
      agentTranscriptPath: trimOptional(payload.agentTranscriptPath),
      payloadTranscriptPath: trimOptional(payload.transcriptPath),
      samePath: isSameTranscriptPath(trimOptional(payload.agentTranscriptPath), trimOptional(payload.transcriptPath)),
      reason: source.reason,
      shouldSubscribe,
    });

    const subscribeChild = async () => {
      if (source.kind !== "child-jsonl" || !source.transcriptPath) {
        logWarn("[subagent_transcript] skip full parent transcript tail", {
          event: payload.event,
          pseudoId,
          agentId,
          toolUseId,
          sourceKind: source.kind,
          reason: source.reason,
          wslDistroName: resolvedWslDistroName,
        });
        return false;
      }
      try {
        const result = await invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
          key: pseudoId,
          transcriptPath: source.transcriptPath,
          cwd: payload.cwd ?? null,
          sessionId: payload.sessionId ?? null,
          agentId,
          wslDistroName: resolvedWslDistroName,
        });
        if (result.initialContent) {
          useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
        }
        stopSubagentTranscriptRetry(pseudoId, "explicit_child_subscribed");
        logInfo("[subagent_transcript] subscribed child transcript", {
          pseudoId,
          path: result.path,
          initialBytes: result.initialContent.length,
        });
        return true;
      } catch (err) {
        logError("subagent_transcript_subscribe failed", { pseudoId, err });
        return false;
      }
    };

    const subscribeDerivedChild = async () => {
      if (!shouldAttemptDerivedChildTranscript(payload, source)) {
        logInfo("[subagent_transcript] derived subscription not attempted", {
          event: payload.event,
          pseudoId,
          agentId,
          sourceKind: source.kind,
          wslDistroName: resolvedWslDistroName,
        });
        return false;
      }
      try {
        const result = await invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
          key: pseudoId,
          transcriptPath: null,
          cwd: payload.cwd ?? null,
          sessionId: payload.sessionId ?? null,
          agentId,
          wslDistroName: resolvedWslDistroName,
        });
        const childSource: SubagentTranscriptSource = {
          kind: "child-jsonl",
          transcriptPath: result.path,
          parentTranscriptPath: source.parentTranscriptPath,
        };
        useTerminalStore.setState((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === pseudoId && session.kind === "subagent-transcript" && session.subagent
              ? { ...session, subagent: { ...session.subagent, source: childSource } }
              : session
          ),
          subagentTranscripts: {
            ...state.subagentTranscripts,
            [pseudoId]: {
              ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false, resetSeq: 0 }),
              source: childSource,
            },
          },
        }));
        if (result.initialContent) {
          useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
        }
        stopSubagentTranscriptRetry(pseudoId, "derived_child_subscribed");
        logInfo("[subagent_transcript] derived child transcript subscription", {
          pseudoId,
          agentId,
          derivedPath: result.path,
          initialBytes: result.initialContent.length,
        });
        return true;
      } catch (err) {
        logWarn("[subagent_transcript] derived child transcript unavailable", { pseudoId, agentId, err });
        return true;
      }
    };

    const subscribeCodexRolloutChild = async () => {
      if (payload.source !== "codex" || source.kind === "child-jsonl" || !agentId || !payload.sessionId?.trim()) {
        return false;
      }

      try {
        const codexConfigDir = useSettingsStore.getState().codexHookConfigDir ?? undefined;
        logInfo("[subagent_transcript] codex rollout discovery requested", {
          pseudoId,
          agentId,
          parentSessionId: payload.sessionId,
          codexConfigDir: codexConfigDir ?? null,
          cwd: payload.cwd ?? null,
          resolvedWslDistroName,
          sourceKind: source.kind,
          sourceReason: source.reason ?? null,
          parentTranscriptPath: source.parentTranscriptPath ?? null,
          payloadTranscriptPath: trimOptional(payload.transcriptPath),
          payloadAgentTranscriptPath: trimOptional(payload.agentTranscriptPath),
        });
        const discoveredPath = await invoke<string | null>("codex_subagent_transcript_discover", {
          parentSessionId: payload.sessionId,
          agentId,
          codexConfigDir,
          wslDistroName: resolvedWslDistroName,
          parentTranscriptPath: source.parentTranscriptPath ?? null,
        });
        if (!discoveredPath) {
          logInfo("[subagent_transcript] codex rollout transcript not found yet", {
            pseudoId,
            agentId,
            parentSessionId: payload.sessionId,
            codexConfigDir: codexConfigDir ?? null,
            sourceKind: source.kind,
            sourceReason: source.reason ?? null,
            parentTranscriptPath: source.parentTranscriptPath ?? null,
          });
          return false;
        }

        logInfo("[subagent_transcript] codex rollout discovered path", {
          pseudoId,
          agentId,
          parentSessionId: payload.sessionId,
          discoveredPath,
          codexConfigDir: codexConfigDir ?? null,
        });
        const result = await invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
          key: pseudoId,
          transcriptPath: discoveredPath,
          cwd: payload.cwd ?? null,
          sessionId: payload.sessionId ?? null,
          agentId,
          wslDistroName: resolvedWslDistroName,
        });
        const childSource: SubagentTranscriptSource = {
          kind: "child-jsonl",
          transcriptPath: result.path,
          parentTranscriptPath: source.parentTranscriptPath,
        };
        useTerminalStore.setState((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === pseudoId && session.kind === "subagent-transcript" && session.subagent
              ? { ...session, subagent: { ...session.subagent, source: childSource } }
              : session
          ),
          subagentTranscripts: {
            ...state.subagentTranscripts,
            [pseudoId]: {
              ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false, resetSeq: 0 }),
              source: childSource,
            },
          },
        }));
        if (result.initialContent) {
          useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
        }
        stopSubagentTranscriptRetry(pseudoId, "codex_rollout_subscribed");
        logInfo("[subagent_transcript] subscribed codex rollout transcript", {
          pseudoId,
          agentId,
          path: result.path,
          initialBytes: result.initialContent.length,
        });
        return true;
      } catch (err) {
        logWarn("[subagent_transcript] codex rollout transcript subscribe failed", {
          pseudoId,
          agentId,
          err,
        });
        return false;
      }
    };

    const subscribeAvailableChild = async () => {
      if (shouldSubscribe) {
        await subscribeChild();
        return;
      }

      const codexSubscribed = await subscribeCodexRolloutChild();
      if (
        !codexSubscribed &&
        payload.source === "codex" &&
        payload.event === "SubagentStart" &&
        source.kind !== "child-jsonl" &&
        agentId &&
        payload.sessionId?.trim()
      ) {
        startSubagentTranscriptRetry(pseudoId, subscribeCodexRolloutChild);
      }
      if (!codexSubscribed && !(await subscribeDerivedChild()) && source.kind !== "child-jsonl") {
        await subscribeChild();
      }
    };

    // 去重：同一子 Agent 已有面板则更新 source；仅发现/切换 child JSONL 时订阅。
    if (sessions.some((session) => session.id === pseudoId)) {
      const agentType = payload.agentType?.trim() || null;
      const parentSession = sessions.find((session) => session.id === parentTabId);
      const existingSession = sessions.find((session) => session.id === pseudoId);

      // 如果这次更新带来了 agentType（通常是 SubagentStart 绑定到 AgentToolStart 创建的 placeholder），重建标题。
      const shouldUpdateTitle = agentType && existingSession && (!existingSession.subagent?.agentType);
      const newTitle = shouldUpdateTitle
        ? buildSubagentTitle(
            parentSession,
            agentType,
            sessions.filter((s) => s.kind === "subagent-transcript" && s.subagent?.parentSessionId === parentTabId && s.id !== pseudoId).length
          )
        : undefined;

      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === pseudoId && session.kind === "subagent-transcript" && session.subagent
            ? {
                ...session,
                title: newTitle ?? session.title,
                subagent: {
                  ...session.subagent,
                  agentId: agentId ?? session.subagent.agentId,
                  toolUseId: toolUseId ?? session.subagent.toolUseId,
                  agentType: agentType ?? session.subagent.agentType,
                  source,
                },
              }
            : session
        ),
        subagentTranscripts: {
          ...state.subagentTranscripts,
          [pseudoId]: { ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false, resetSeq: 0 }), ended: false, source },
        },
      }));
      await subscribeAvailableChild();
      return;
    }

    if (!splitViewEnabled) {
      logInfo("[subagent_transcript] split view disabled, skipping new pane", {
        event: payload.event,
        parentTabId,
        agentId,
        toolUseId,
      });
      return;
    }

    // AgentToolStart/AgentToolStop 在并发场景下无法可靠关联到 SubagentStart（前者只有 toolUseId，后者只有 agentId）。
    // 策略：这两个事件只触发 discovery，不创建 UI；SubagentStart 创建真实 Tab，discovery 负责升级内容源。
    // Claude 在部分 WSL 场景只发 ToolStart/ToolStop + agentId，因此这类事件允许创建降级 pane 并尝试派生订阅。
    if (payload.event === "AgentToolStart" || payload.event === "AgentToolStop") {
      if (!agentId && (resolvedSource.kind === "pending" || resolvedSource.kind === "lifecycle-only")) {
        startSubagentDiscovery(parentTabId, payload.sessionId ?? null, payload.cwd ?? null, resolvedWslDistroName);
      } else {
        logInfo("[subagent_discovery] not started for AgentTool event", {
          event: payload.event,
          parentTabId,
          agentId,
          resolvedSourceKind: resolvedSource.kind,
          wslDistroName: resolvedWslDistroName,
        });
      }
      return;
    }

    const agentType = payload.agentType?.trim() || null;
    const parentSession = sessions.find((session) => session.id === parentTabId);
    const existingSubagentCount = sessions.filter(
      (session) => session.kind === "subagent-transcript" && session.subagent?.parentSessionId === parentTabId
    ).length;
    const pseudoSession: TerminalSession = {
      id: pseudoId,
      title: buildSubagentTitle(parentSession, agentType, existingSubagentCount),
      kind: "subagent-transcript",
      subagent: {
        parentSessionId: parentTabId,
        agentId: agentId ?? undefined,
        toolUseId: toolUseId ?? undefined,
        agentType: agentType ?? undefined,
        source,
      },
    };

    // 并行多子 Agent：同父已有转录面板则作为该 pane 内的 Tab 追加，避免布局被多 pane 撑爆；
    // 否则从父 Tab 所在 pane 分屏出新面板。
    const existingTranscript = sessions.find(
      (session) => session.kind === "subagent-transcript" && session.subagent?.parentSessionId === parentTabId
    );
    const existingPane = existingTranscript ? findPaneLeafBySession(tree, existingTranscript.id) : null;
    let nextTree: TerminalPaneNode | null;
    if (existingPane) {
      nextTree = addSessionToPaneTree(tree, existingPane.id, pseudoId, createPaneId).tree;
    } else {
      const parentPane = findPaneLeafBySession(tree, parentTabId);
      if (!parentPane) return;
      nextTree = splitPaneLeaf(tree, parentPane.id, "horizontal", pseudoId, createPaneId).tree;
    }

    const newSessions = [...sessions, pseudoSession];
    // 不抢焦点：保留当前 activeSessionId（终端），转录在其分屏 pane 中即时可见。
    const state = get();
    const workspans = updateTerminalWorkspan(state.workspans, parentWorkspan.id, (workspan) => (
      syncTerminalWorkspanLayout(workspan, nextTree, workspan.activePaneId, workspan.activeSessionId)
    ));
    const workspanState = state.activeWorkspanId === parentWorkspan.id
      ? buildWorkspanMirror(workspans, parentWorkspan.id)
      : { workspans };
    set({
      sessions: newSessions,
      ...workspanState,
      subagentTranscripts: { ...state.subagentTranscripts, [pseudoId]: { content: "", ended: false, resetSeq: 0, source } },
    });

    // 持久化（sessionStore 会过滤掉转录伪会话）。
    void useSessionStore.getState().saveSessions(newSessions).catch(() => {});
    persistWorkspanState(workspans, state.activeWorkspanId, newSessions);

    await subscribeAvailableChild();
  },

  finishSubagentTranscript: (payload) => {
    const sessionId = findSubagentSessionId(get().sessions, payload);
    if (!sessionId) {
      const candidates = get().sessions.filter(
        (session) => session.kind === "subagent-transcript" && session.subagent?.parentSessionId === payload.tabId
      );
      logWarn("[subagent_transcript] stop target not resolved", {
        tabId: payload.tabId,
        agentId: trimOptional(payload.agentId),
        candidateCount: candidates.length,
      });
      return;
    }
    logInfo("[subagent_transcript] stop target resolved", {
      sessionId,
      tabId: payload.tabId,
      agentId: trimOptional(payload.agentId),
    });
    stopSubagentTranscriptRetry(sessionId, "subagent_finished");

    // 停止对应的目录扫描（如果有）
    const parentSessionId = payload.sessionId ?? null;
    if (parentSessionId) {
      const discoveryKey = `${payload.tabId}:${parentSessionId}`;
      const discoveryTimer = subagentDiscoveryTimers.get(discoveryKey);
      if (discoveryTimer) {
        clearInterval(discoveryTimer);
        subagentDiscoveryTimers.delete(discoveryKey);
        logInfo("[subagent_discovery] stopped by finishSubagentTranscript", { discoveryKey });
      }
    }

    set((state) => {
      const prev = state.subagentTranscripts[sessionId];
      if (!prev) return state;
      return {
        subagentTranscripts: { ...state.subagentTranscripts, [sessionId]: { ...prev, ended: true } },
      };
    });

    const existingTimer = subagentCloseTimers.get(sessionId);
    if (existingTimer) clearTimeout(existingTimer);
    const currentTranscript = get().subagentTranscripts[sessionId];
    const closeDelayMs =
      currentTranscript?.source.kind === "child-jsonl" || payload.source === "codex"
        ? SUBAGENT_CHILD_JSONL_CLOSE_DELAY_MS
        : SUBAGENT_CLOSE_DELAY_MS;
    logInfo("[subagent_transcript] schedule transcript close", { sessionId, closeDelayMs, sourceKind: currentTranscript?.source.kind });
    const timer = setTimeout(() => {
      subagentCloseTimers.delete(sessionId);
      const store = useTerminalStore.getState();
      if (!store.sessions.some((session) => session.id === sessionId)) return;
      void store.closeSession(sessionId);
    }, closeDelayMs);
    subagentCloseTimers.set(sessionId, timer);
  },

  appendSubagentTranscript: (key, content, reset) => {
    set((state) => {
      const prev = state.subagentTranscripts[key];
      // 仅更新已存在的订阅（本窗口 openSubagentTranscript 预置）；未知 key 忽略（多窗口广播）。
      if (!prev) return state;
      let droppedChars = 0;
      let nextContent: string;
      if (content.length >= SUBAGENT_TRANSCRIPT_MAX_CHARS) {
        nextContent = content.slice(-SUBAGENT_TRANSCRIPT_MAX_CHARS);
        droppedChars = (reset ? 0 : prev.content.length) + content.length - nextContent.length;
      } else if (reset) {
        nextContent = content;
      } else {
        const maxPrevChars = SUBAGENT_TRANSCRIPT_MAX_CHARS - content.length;
        const prevTail = prev.content.length > maxPrevChars ? prev.content.slice(-maxPrevChars) : prev.content;
        droppedChars = prev.content.length - prevTail.length;
        nextContent = prevTail + content;
      }
      if (droppedChars > 0) {
        debugConsoleWarn("[oom-diagnostics:webview]", {
          area: "subagentTranscript",
          phase: "appendTrim",
          key,
          droppedChars,
          contentChars: content.length,
          retainedChars: nextContent.length,
          maxChars: SUBAGENT_TRANSCRIPT_MAX_CHARS,
          reset,
          thresholdExceeded: true,
        });
        logWarn("[oom-diagnostics:webview] subagent transcript trimmed", {
          area: "subagentTranscript",
          phase: "appendTrim",
          key,
          droppedChars,
          contentChars: content.length,
          retainedChars: nextContent.length,
          maxChars: SUBAGENT_TRANSCRIPT_MAX_CHARS,
          reset,
          thresholdExceeded: true,
        });
      }
      return {
        subagentTranscripts: {
          ...state.subagentTranscripts,
          [key]: {
            ...prev,
            content: nextContent,
            truncatedBytes: (reset ? 0 : prev.truncatedBytes ?? 0) + droppedChars,
            // reset 或前部裁剪都破坏"纯尾部追加"前提，自增序号通知消费方全量重解析。
            resetSeq: reset || droppedChars > 0 ? (prev.resetSeq ?? 0) + 1 : prev.resetSeq ?? 0,
          },
        },
      };
    });
  },
}));

startPtyOrphanReconcileHeartbeat();
