import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { SubagentTranscriptSource, TerminalSession, Project } from "../lib/types";
import { logError, logInfo, logWarn } from "../lib/logger";
import { normalizeDirectCodexStartupCommand, withCodexLightTuiTheme } from "../lib/projectStartupCommand";
import { getTerminalTheme } from "../lib/terminalThemes";
import { useSettingsStore } from "./settingsStore";
import { useSessionStore } from "./sessionStore";
import { defaultShellForOs, getOsPlatform, normalizeShellForOs, normalizeShellKey, type OsPlatform, type ShellKey } from "../lib/shell";
import { getCodexProviderOverride, isExactCodexProject } from "../lib/providerSwitching";
import { useProjectStore } from "./projectStore";
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
  splitPaneEmpty as splitPaneEmptyTree,
  splitPaneLeaf,
  splitExistingSessionToPaneEdge,
  unsplitPaneLeaf,
  type TerminalPaneDropEdge,
  type TerminalPaneNode,
  type TerminalPaneSplitDirection,
} from "./terminalPaneTree";

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
  sessionStatuses: Record<string, SessionStatus>;
  statusListeners: Record<string, UnlistenFn>;
  tabNotifications: Record<string, TabNotificationState>;
  tabStatuses: Record<string, TabStatusSources>;
  tabStatusDetails: Record<string, TabStatusDetails>;
  splits: Record<string, SplitState>;
  hiddenBackgroundSessionIds: Set<string>;
  subagentTranscripts: Record<string, SubagentTranscriptContent>;
  createSession: (projectId?: string, cwd?: string, title?: string, startupCmd?: string, envVars?: Record<string, string>, shell?: string, paneId?: string) => Promise<string>;
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
  openFileEditorPane: (project: Project) => string;
  /** Split the current pane into two, creating a new empty leaf (no sessions). Used by batch launch to create panes for different root groups. */
  splitPaneEmpty: (paneId: string, direction: TerminalPaneSplitDirection) => void;
  unsplitTerminal: (sessionId: string) => Promise<void>;
  setSplitRatio: (splitId: string, ratio: number) => void;
  getNextSessionIdForShortcut: (delta: 1 | -1) => string | null;
  restoreSessions: (projectMap: Map<string, Project>, projectHealth: Record<string, boolean>) => Promise<void>;
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

// setActive 防抖：高频切换标签时合并持久化写入
let saveActiveIdTimer: ReturnType<typeof setTimeout> | null = null;
let paneIdSeq = 0;
let subagentSeq = 0;
const subagentCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const subagentDiscoveryTimers = new Map<string, ReturnType<typeof setInterval>>();
const SUBAGENT_CLOSE_DELAY_MS = 1500;
const SUBAGENT_CHILD_JSONL_CLOSE_DELAY_MS = 10_000;
const SUBAGENT_DISCOVERY_INTERVAL_MS = 1000;
const SUBAGENT_DISCOVERY_TTL_MS = 15000;

function createPaneId() {
  paneIdSeq += 1;
  return `pane-${Date.now().toString(36)}-${paneIdSeq.toString(36)}`;
}

function createFileEditorSessionId(projectId: string): string {
  return `file-editor:${projectId}`;
}

function isPersistableSession(session: TerminalSession | undefined): boolean {
  return !!session && session.kind !== "subagent-transcript" && session.kind !== "file-editor";
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
  return payload.event === "AgentToolStop" && source.kind !== "child-jsonl" && Boolean(trimOptional(payload.agentId));
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
                      ...(state.subagentTranscripts[existingSession.id] ?? { content: "", ended: false }),
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

function resolveShellForPty(shell: string | null | undefined, hasProject: boolean, os: OsPlatform): ShellKey | null {
  const inputShell = normalizeShellForOs(shell, os);
  if (inputShell) return inputShell;
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
  const themeName = settings.terminalThemeMode === "follow-app" ? "auto" : settings.terminalThemeName;
  const theme = getTerminalTheme(themeName, settings.resolvedTheme, settings.lightThemePalette, settings.darkThemePalette);
  return isLightHexColor(theme.background);
}

function prepareStartupCommandForPty(command: string | undefined, shell: ShellKey | null): string | undefined {
  if (!command || shell !== "gitbash" || !isCurrentTerminalBackgroundLight()) return command;
  return withCodexLightTuiTheme(command);
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
  try {
    const status = await invoke<HookSettingsStatusPayload>("hook_settings_get_status", {
      selectedDir: settings.claudeHookConfigDir?.trim() || null,
      codexSelectedDir: settings.codexHookConfigDir?.trim() || null,
      ccSwitchDbPath: settings.ccSwitchDbPath ?? undefined,
      autoRepair: settings.claudeHookAutoRepairKnownInstalled,
    });
    return status.claude.status === "installed" || status.codex.status === "installed";
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

function getCodexProviderLaunchConfig(projectId?: string, startupCmd?: string | null) {
  if (!projectId) return null;
  const project = useProjectStore.getState().projects.find((item) => item.id === projectId);
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
  subagentTranscripts: {},

  createSession: async (projectId, cwd, title, startupCmd, envVars, shell, paneId) => {
    const os = await getOsPlatform();
    const resolvedShell = resolveShellForPty(shell, !!projectId, os);
    const launchStartupCmd = prepareStartupCommandForPty(startupCmd, resolvedShell);

    let sessionId: string;
    try {
      sessionId = await invoke<string>("pty_create", {
        cwd: cwd ?? null,
        envVars: buildPtyEnvVars(envVars ?? null, resolvedShell),
        shell: resolvedShell,
        hookEnvEnabled: await shouldEnableHookEnv(),
        codexProvider: getCodexProviderLaunchConfig(projectId, startupCmd),
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
    const paneResult = addSessionToPaneTree(get().paneTree, paneId ?? get().activePaneId, sessionId, createPaneId);
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

    if (launchStartupCmd) {
      setTimeout(() => {
        invoke("pty_write", { sessionId, data: launchStartupCmd + "\r" }).catch((err) => {
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
    const ptySessionIds = [id];
    const closingSession = get().sessions.find((s) => s.id === id);
    const isTranscript = closingSession?.kind === "subagent-transcript";
    const isFileEditor = closingSession?.kind === "file-editor";
    const closeTimer = subagentCloseTimers.get(id);
    if (closeTimer) {
      clearTimeout(closeTimer);
      subagentCloseTimers.delete(id);
    }

    // 必须在 set sessions 之前记录原索引，否则后续 findIndex 永远返回 -1，
    // 导致 persistedSplits 永远清不掉（历史 bug）。
    const closedIndex = get().sessions.findIndex((s) => s.id === id);
    const remaining = get().sessions.filter((s) => s.id !== id);
    const newStatuses = { ...get().sessionStatuses };
    const newListeners = { ...get().statusListeners };
    const newNotifications = { ...get().tabNotifications };
    const newTabStatuses = { ...get().tabStatuses };
    const newTabStatusDetails = { ...get().tabStatusDetails };
    const newSubagentTranscripts = { ...get().subagentTranscripts };
    delete newSubagentTranscripts[id];
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
      subagentTranscripts: newSubagentTranscripts,
      splits: {},
      ...(newHidden !== prevHidden ? { hiddenBackgroundSessionIds: newHidden } : {}),
    });

    try {
      await useSessionStore.getState().saveSessions(remaining);
      const nextActiveSession = nextActiveId ? remaining.find((session) => session.id === nextActiveId) : undefined;
      await useSessionStore.getState().saveActiveSessionId(isPersistableSession(nextActiveSession) ? nextActiveId : null);

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
          void invoke("pty_close", { sessionId }).catch((err) => {
            logError("pty_close invoke failed while closing terminal tab", { sessionId, err });
          });
        }
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

  splitPaneEmpty: (paneId, direction) => {
    const state = get();
    if (!state.paneTree) return;
    const result = splitPaneEmptyTree(state.paneTree, paneId, direction, createPaneId);
    set({ paneTree: result.tree, activePaneId: result.activePaneId });
  },

  splitTerminal: async (sessionId, direction, options) => {
    const paneTree = get().paneTree;
    const targetPane = findPaneLeafBySession(paneTree, sessionId);
    if (!targetPane || !paneTree) return null;

    const os = await getOsPlatform();
    const resolvedShell = resolveShellForPty(options?.shell, !!options?.projectId, os);
    const launchStartupCmd = prepareStartupCommandForPty(options?.startupCmd, resolvedShell);

    let splitSessionId: string;
    try {
      splitSessionId = await invoke<string>("pty_create", {
        cwd: options?.cwd ?? null,
        envVars: buildPtyEnvVars(options?.envVars ?? null, resolvedShell),
        shell: resolvedShell,
        hookEnvEnabled: await shouldEnableHookEnv(),
        codexProvider: getCodexProviderLaunchConfig(options?.projectId, options?.startupCmd),
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

    if (launchStartupCmd) {
      setTimeout(() => {
        invoke("pty_write", { sessionId: splitSessionId, data: launchStartupCmd + "\r" }).catch((err) => {
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
      const paneResult = setPaneActiveSession(get().paneTree, editorSessionId);
      set({
        activeSessionId: editorSessionId,
        activePaneId: paneResult.activePaneId ?? get().activePaneId,
        paneTree: paneResult.tree,
      });
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
    const sessions = [...get().sessions, editorSession];
    const tree = get().paneTree;
    const activePaneId = get().activePaneId;
    const paneResult = addSessionToPaneTree(tree, activePaneId, editorSessionId, createPaneId);

    set({
      sessions,
      activeSessionId: editorSessionId,
      activePaneId: paneResult.activePaneId,
      paneTree: paneResult.tree,
      splits: {},
    });
    void useSessionStore.getState().saveSessions(sessions).catch(() => {});
    return editorSessionId;
  },

  unsplitTerminal: async (sessionId) => {
    const pane = findPaneLeafBySession(get().paneTree, sessionId);
    if (!pane) return;
    const behavior = useSettingsStore.getState().unsplitBehavior;
    const result = unsplitPaneLeaf(get().paneTree, pane.id, behavior);
    const closedSessionIds = result.closedSessionIds;
    const transcriptClosedIds = new Set(
      get().sessions
        .filter((s) => closedSessionIds.includes(s.id) && s.kind === "subagent-transcript")
        .map((s) => s.id)
    );
    const fileEditorClosedIds = new Set(
      get().sessions
        .filter((s) => closedSessionIds.includes(s.id) && s.kind === "file-editor")
        .map((s) => s.id)
    );

    for (const closedSessionId of closedSessionIds) {
      get().statusListeners[closedSessionId]?.();
    }

    const newStatuses = { ...get().sessionStatuses };
    const newListeners = { ...get().statusListeners };
    const newNotifications = { ...get().tabNotifications };
    const newTabStatuses = { ...get().tabStatuses };
    const newTabStatusDetails = { ...get().tabStatusDetails };
    const newSubagentTranscripts = { ...get().subagentTranscripts };
    const newHidden = new Set(get().hiddenBackgroundSessionIds);
    for (const closedSessionId of closedSessionIds) {
      delete newStatuses[closedSessionId];
      delete newListeners[closedSessionId];
      delete newNotifications[closedSessionId];
      delete newTabStatuses[closedSessionId];
      delete newTabStatusDetails[closedSessionId];
      delete newSubagentTranscripts[closedSessionId];
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
      subagentTranscripts: newSubagentTranscripts,
    });

    await useSessionStore.getState().saveSessions(remaining);
    const nextActiveSession = result.activeSessionId
      ? remaining.find((session) => session.id === result.activeSessionId)
      : undefined;
    await useSessionStore.getState().saveActiveSessionId(
      isPersistableSession(nextActiveSession) ? result.activeSessionId : null
    );
    await useSessionStore.getState().saveSplits([]);

    for (const closedSessionId of closedSessionIds) {
      if (fileEditorClosedIds.has(closedSessionId)) {
        continue;
      }
      if (transcriptClosedIds.has(closedSessionId)) {
        void invoke("subagent_transcript_unsubscribe", { key: closedSessionId }).catch((err) => {
          logError("subagent_transcript_unsubscribe failed while unsplitting pane", { key: closedSessionId, err });
        });
      } else {
        void invoke("pty_close", { sessionId: closedSessionId }).catch((err) => {
          logError("pty_close invoke failed while unsplitting pane", { sessionId: closedSessionId, err });
        });
      }
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

    const os = await getOsPlatform();
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
      const resolvedShell = resolveShellForPty(ps.shell, !!ps.projectId, os);

      let newSessionId: string;
      try {
        newSessionId = await invoke<string>("pty_create", {
          cwd: ps.cwd ?? null,
          envVars: buildPtyEnvVars(ps.envVars ?? null, resolvedShell),
          shell: resolvedShell,
          hookEnvEnabled: await shouldEnableHookEnv(),
          codexProvider: getCodexProviderLaunchConfig(ps.projectId, ps.startupCmd),
        });
      } catch (err) {
        logError("Failed to restore session", { session: ps, err });
        skippedSessions.push(ps.title ?? `会话 ${i + 1}`);
        continue;
      }

      newIdMap[ps.id] = newSessionId;

      const restoredStartupCmd = normalizeDirectCodexStartupCommand(ps.startupCmd);
      const launchStartupCmd = prepareStartupCommandForPty(restoredStartupCmd, resolvedShell);
      const restoredSession: TerminalSession = {
        id: newSessionId,
        projectId: ps.projectId,
        title: ps.title,
        cwd: ps.cwd,
        shell: resolvedShell,
        envVars: ps.envVars,
        startupCmd: restoredStartupCmd,
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
      if (launchStartupCmd) {
        setTimeout(() => {
          invoke("pty_write", { sessionId: newSessionId, data: launchStartupCmd + "\r" }).catch((err) => {
            logError("Failed to write startup command on restore", {
              sessionId: newSessionId,
              hasStartupCmd: true,
              startupCmdSummary: summarizeStartupCmd(launchStartupCmd),
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

    const tree = get().paneTree;
    if (!tree) return;

    const agentId = trimOptional(payload.agentId);
    const toolUseId = trimOptional(payload.toolUseId);
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
      wslDistroName: payload.wslDistroName ?? null,
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
          wslDistroName: payload.wslDistroName ?? null,
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
          wslDistroName: payload.wslDistroName ?? null,
        });
        if (result.initialContent) {
          useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
        }
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
          wslDistroName: payload.wslDistroName ?? null,
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
          wslDistroName: payload.wslDistroName ?? null,
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
              ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false }),
              source: childSource,
            },
          },
        }));
        if (result.initialContent) {
          useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
        }
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
        const discoveredPath = await invoke<string | null>("codex_subagent_transcript_discover", {
          parentSessionId: payload.sessionId,
          agentId,
          codexConfigDir,
        });
        if (!discoveredPath) {
          logInfo("[subagent_transcript] codex rollout transcript not found yet", {
            pseudoId,
            agentId,
            parentSessionId: payload.sessionId,
          });
          return false;
        }

        const result = await invoke<SubagentTranscriptSubscribeResult>("subagent_transcript_subscribe", {
          key: pseudoId,
          transcriptPath: discoveredPath,
          cwd: payload.cwd ?? null,
          sessionId: payload.sessionId ?? null,
          agentId,
          wslDistroName: payload.wslDistroName ?? null,
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
              ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false }),
              source: childSource,
            },
          },
        }));
        if (result.initialContent) {
          useTerminalStore.getState().appendSubagentTranscript(pseudoId, result.initialContent, true);
        }
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
          [pseudoId]: { ...(state.subagentTranscripts[pseudoId] ?? { content: "", ended: false }), ended: false, source },
        },
      }));
      if (shouldSubscribe) await subscribeChild();
      else if (!(await subscribeCodexRolloutChild()) && !(await subscribeDerivedChild()) && source.kind !== "child-jsonl") await subscribeChild();
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
    if (payload.event === "AgentToolStart" || payload.event === "AgentToolStop") {
      if (!agentId && (resolvedSource.kind === "pending" || resolvedSource.kind === "lifecycle-only")) {
        startSubagentDiscovery(parentTabId, payload.sessionId ?? null, payload.cwd ?? null, payload.wslDistroName ?? null);
      } else {
        logInfo("[subagent_discovery] not started for AgentTool event", {
          event: payload.event,
          parentTabId,
          agentId,
          resolvedSourceKind: resolvedSource.kind,
          wslDistroName: payload.wslDistroName ?? null,
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
    set((state) => ({
      sessions: newSessions,
      paneTree: nextTree,
      subagentTranscripts: { ...state.subagentTranscripts, [pseudoId]: { content: "", ended: false, source } },
    }));

    // 持久化（sessionStore 会过滤掉转录伪会话）。
    void useSessionStore.getState().saveSessions(newSessions).catch(() => {});

    if (shouldSubscribe) await subscribeChild();
    else if (!(await subscribeCodexRolloutChild()) && !(await subscribeDerivedChild())) await subscribeChild();
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
      currentTranscript?.source.kind === "child-jsonl" || (payload.source === "codex" && trimOptional(payload.agentTranscriptPath))
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
      const nextContent = (reset ? "" : prev.content) + content;
      return {
        subagentTranscripts: { ...state.subagentTranscripts, [key]: { ...prev, content: nextContent } },
      };
    });
  },
}));
