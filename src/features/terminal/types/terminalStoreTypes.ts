import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  Project, NativeProviderLaunchSnapshot, RemoteHandoffSessionState, SshConnectionState,
  SshDisconnectReason, SubagentTranscriptSource, TerminalSession,
} from "../../../shared/types/index";
import type { SyncedHistoryGroup } from "../../history/api/externalSessionGrouping";
import type { SshConnectionSpecPayload } from "../../remote/api/ssh";
import type {
  TerminalClaudeProviderLaunchConfig, TerminalCodexProviderLaunchConfig,
  TerminalGrokProviderLaunchConfig,
} from "../api/TerminalProcessManager";
import type { TerminalExitNotificationState } from "../api/terminalExitTask";
import type {
  TerminalPaneDropEdge, TerminalPaneNode, TerminalPaneSplitDirection,
} from "../api/terminalPaneTree";
import type { TerminalWorkspan } from "../api/terminalWorkspan";
import type { getCurrentTerminalColors } from "../lib/terminalLaunch";

export type SessionStatus = "running" | "exited" | "error";

export type CliHookSource = "claude" | "codex" | "kimi" | "pi" | "grok" | "opencode";

export type CliHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "Notification"
  | "Stop"
  | "StopFailure"
  | "PermissionRequest"
  | "PermissionResult"
  | "Interrupt"
  | "SubagentStart"
  | "SubagentStop"
  | "AgentToolStart"
  | "AgentToolStop"
  | "ToolStart"
  | "ToolStop";

export type TabNotificationState = TerminalExitNotificationState;

export type ShellRuntimeEventName = "command_started" | "command_finished" | "prompt_shown";

export interface DaemonSessionState {
  alive: boolean;
  cwd?: string | null;
  shell?: string | null;
  environmentType?: string | null;
  sshHostId?: string | null;
  remotePath?: string | null;
  createdAtMs?: number;
  taskStatus?: TabNotificationState | null;
  taskUpdatedAtMs?: number | null;
}

export interface DaemonSessionMeta extends DaemonSessionState {
  sessionId: string;
}

export type TabStatusSourceName = "hook" | "shell";

export interface TabStatusSources {
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
  transcriptBytes?: number | null;
  reasoningEffort?: string | null;
  wslDistroName?: string | null;
  environmentType?: "ssh" | null;
  remoteHostId?: string | null;
  remoteProjectId?: string | null;
  remoteTranscriptRef?: string | null;
  remoteAgentTranscriptRef?: string | null;
  remoteEventId?: string | null;
  remoteSequence?: number | null;
}

export interface SubagentTranscriptContent {
  content: string;
  ended: boolean;
  source: SubagentTranscriptSource;
  truncatedBytes?: number;
  /** 重置序号：reset 或前部裁剪时自增；序号不变 ⇒ content 相对上次为纯尾部追加，消费方可增量解析。 */
  resetSeq: number;
}

export interface SubagentTranscriptSubscribeResult {
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

export interface HookToolStatus {
  status: "directoryMissing" | "notInstalled" | "partialInstalled" | "installed" | "unsupported";
}

export interface HookSettingsStatusPayload {
  claude: HookToolStatus;
  codex: HookToolStatus;
  kimi: HookToolStatus;
  pi: HookToolStatus;
  grok: HookToolStatus;
  claudeAutoRepaired?: boolean;
}

export interface OpenCodeHookStatusPayload {
  status: "notInstalled" | "installed" | "conflict";
}

export interface PtyStatusPayload {
  status: string;
  exit_code: number | null;
}

export interface TerminalStore {
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
  ptyOutputActivityAt: Record<string, number>;
  splits: Record<string, SplitState>;
  hiddenBackgroundSessionIds: Set<string>;
  /** 仅运行态：XTerm 输出监听就绪后才可执行 daemon attach。 */
  daemonAttachPendingSessionIds: Set<string>;
  subagentTranscripts: Record<string, SubagentTranscriptContent>;
  createSession: (projectId?: string, cwd?: string, title?: string, startupCmd?: string, envVars?: Record<string, string>, shell?: string, paneId?: string, worktreeId?: string, sshHostId?: string, cliSessionId?: string, remoteHistoryConsumerId?: string, remoteHistorySourceInstanceId?: string) => Promise<string>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  setWorkspanModeEnabled: (enabled: boolean) => void;
  setActiveWorkspan: (id: string) => void;
  reorderWorkspans: (fromId: string, toId: string) => void;
  renameWorkspan: (id: string, title: string) => void;
  restoreWorkspanToSinglePane: (id: string) => void;
  mergeWorkspanAtPaneEdge: (sourceId: string, targetId: string, targetPaneId: string, edge: TerminalPaneDropEdge) => void;
  updateSessionCwd: (sessionId: string, cwd: string) => void;
  updateSshConnectionState: (sessionId: string, connectionState: SshConnectionState, disconnectReason?: SshDisconnectReason) => void;
  updateSessionTerminalSnapshot: (sessionId: string, initialTerminalOutput: string) => void;
  suspendSessionForRemoteHandoff: (sessionId: string, handoff: RemoteHandoffSessionState) => Promise<void>;
  updateSessionRemoteHandoff: (sessionId: string, handoff: RemoteHandoffSessionState) => Promise<void>;
  resumeSessionFromRemoteHandoff: (sessionId: string) => Promise<string>;
  restorePersistedRemoteHandoffSessions: () => void;
  bindRemoteCliSessionIdentity: (
    sessionId: string,
    cliSessionId: string,
    remoteHistorySourceInstanceId?: string,
  ) => Promise<boolean>;
  recordPtyOutputActivity: (sessionId: string) => void;
  markAttentionInputHandled: (sessionId: string) => void;
  handleCliHookEvent: (payload: CliHookPayload) => string | null;
  handleShellRuntimeEvent: (payload: ShellRuntimePayload) => string | null;
  /** 终端侧栏实时统计刷新序号：Hook 绑定 sessionId / 回合结束时递增，面板立即重拉。 */
  statsPanelRefreshSeq: number;
  bumpStatsPanelRefresh: () => void;
  reorderSessions: (fromId: string, toId: string) => void;
  moveSessionToPane: (sessionId: string, targetPaneId: string, beforeSessionId?: string) => void;
  detachSessionToWorkspan: (sessionId: string, insertAt?: number) => void;
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
  /**
   * 退出拦截用的任务会话 id。
   * 默认与 getRunningTaskSessionIds 一致；includeFinished=true 时额外纳入
   * hook 状态为 done/failed 的 Claude/Codex 会话（Issue #142）。
   */
  getExitTaskSessionIds: (includeFinished?: boolean) => string[];
  hideBackgroundForSession: (sessionId: string) => void;
  showBackgroundForSession: (sessionId: string) => void;
  /** 收到 CLI SubagentStart：在发起 Tab 所在 pane 分屏出只读转录面板并开始 tail。 */
  openSubagentTranscript: (payload: CliHookPayload) => Promise<void>;
  /** 收到 CLI SubagentStop：标记完成并延迟关闭对应子 Agent 转录面板。 */
  finishSubagentTranscript: (payload: CliHookPayload) => void;
  /** tail 增量推送：追加（reset=true 时替换）某转录面板内容。 */
  appendSubagentTranscript: (key: string, content: string, reset: boolean) => void;
}

export type WindowWithPtyOrphanTimer = Window & {
  __CLI_MANAGER_PTY_ORPHAN_RECONCILE_TIMER__?: ReturnType<typeof setInterval>;
};

export interface DetachedPtyLaunchOptions {
  projectId?: string;
  worktreeId?: string;
  sshHostId?: string;
  cwd?: string | null;
  startupCmd?: string | null;
  envVars?: Record<string, string> | null;
  shell?: string | null;
  providerSnapshot?: NativeProviderLaunchSnapshot | null;
  providerId?: string | null;
}

export interface DetachedPtyLaunchResult {
  sessionId: string;
  shell: string | null;
  startupCmd?: string;
  providerSnapshot?: NativeProviderLaunchSnapshot;
}

export type ProviderLaunchSnapshotResponse = NativeProviderLaunchSnapshot;

export interface SshLaunchPayload extends SshConnectionSpecPayload {
  hostId: string;
  remotePath: string;
  clientInstanceId: string;
  projectId: string;
  projectName: string;
  bridgeEpoch: string;
  agentPath: string;
  agentInstallationId: string;
  agentRemoteMachineId: string;
  toolSource: "" | "claude" | "codex" | "kimi" | "grok";
  environmentOverrides: Record<string, string>;
  initializationCommand: string | null;
  startupCommand: string | null;
}

export interface ResolvedPtyLaunch {
  shell: string | null;
  startupCmd?: string;
  startupHandledByLaunch: boolean;
  environmentType?: "ssh";
  sshHostId?: string;
  remotePath?: string;
  providerSnapshot: NativeProviderLaunchSnapshot | null;
  invokeArgs: {
    cwd: string | null;
    envVars: Record<string, string> | null;
    shell: string | null;
    hookEnvEnabled: boolean;
    claudeProvider: TerminalClaudeProviderLaunchConfig | null;
    codexProvider: TerminalCodexProviderLaunchConfig | null;
    grokProvider: TerminalGrokProviderLaunchConfig | null;
    terminalColors: ReturnType<typeof getCurrentTerminalColors>;
    sshLaunch: SshLaunchPayload | null;
  };
}
