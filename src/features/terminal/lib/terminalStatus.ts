import type { SshDisconnectReason, TerminalSession } from "../../../shared/types/index";
import { logInfo, recordCrashActivity } from "../../../shared/platform/logger";
import { useProjectStore } from "../../projects/api/projectStore";
import { translateCurrent } from "../../../shared/i18n/index";
import { findProjectByPath, findWorktreeByPath } from "../api/terminalProject";
import {
  type CliHookEventName, type TabNotificationState, type ShellRuntimeEventName,
  type DaemonSessionState, type TabStatusSourceName, type TabStatusSources, type TabStatusDetails,
  type SplitState, type PtyStatusPayload, type TerminalStore,
} from "../types/terminalStoreTypes";

export const SHELL_RUNTIME_MONITORING_ENV = "CLI_MANAGER_SHELL_RUNTIME_MONITORING";

export const PTY_OUTPUT_ACTIVITY_UPDATE_INTERVAL_MS = 1000;

export const TAB_STATUS_PRIORITY: Record<TabNotificationState, number> = {
  none: 0,
  done: 1,
  running: 2,
  failed: 3,
  attention: 4,
};

export const SUBAGENT_TRANSCRIPT_MAX_CHARS = 4 * 1024 * 1024;

export function formatTerminalCreateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.trim().startsWith("provider_not_found")) {
    return translateCurrent("terminal.toast.providerNotFound");
  }
  if (message.includes("ssh_project_configuration_invalid") || message.includes("ssh_host_not_found")) {
    return translateCurrent("terminal.ssh.rebindRequired");
  }
  if (message.includes("ssh_client_unavailable") || message.includes("executable not found")) {
    return translateCurrent("terminal.ssh.clientUnavailable");
  }
  if (message.includes("ssh_credential_missing") || message.includes("ssh_credential_ref_required")) {
    return translateCurrent("terminal.ssh.credentialMissing");
  }
  if (message.includes("pty_host_upgrade_sessions_active")) {
    return translateCurrent("terminal.ssh.daemonUpgradeBlocked");
  }
  return message;
}

export function basenameFromPath(path: string | null | undefined): string | null {
  const normalized = path?.trim().replace(/\\/g, "/").replace(/\/+$/g, "") ?? "";
  if (!normalized) return null;
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

export function isGenericDaemonSessionTitle(title: string | null | undefined): boolean {
  const normalized = title?.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "terminal" ||
    normalized === translateCurrent("terminal.backgroundTasks.untitled").toLowerCase() ||
    normalized === "未命名后台任务" ||
    normalized === "untitled background task";
}

export function normalizeDaemonTaskStatus(status: string | null | undefined): TabNotificationState | null {
  if (status === "running" || status === "attention" || status === "done" || status === "failed") return status;
  return null;
}

export function resolveDaemonAttachTaskStatus(attach: DaemonSessionState): TabNotificationState {
  return normalizeDaemonTaskStatus(attach.taskStatus) ?? (attach.alive ? "running" : "done");
}

export function resolveDaemonAttachUpdatedAt(attach: DaemonSessionState): string {
  const updatedAtMs = attach.taskUpdatedAtMs;
  if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
    return new Date(updatedAtMs).toISOString();
  }
  return new Date().toISOString();
}

export function resolveAttachedDaemonSession(
  persisted: TerminalSession | undefined,
  attach: DaemonSessionState
): Pick<TerminalSession, "projectId" | "worktreeId" | "title" | "cwd" | "shell" | "environmentType" | "sshHostId" | "remotePath" | "connectionState" | "disconnectReason"> {
  const projectState = useProjectStore.getState();
  const cwd = persisted?.cwd ?? attach.cwd ?? undefined;
  const worktree = persisted?.worktreeId
    ? projectState.worktrees.find((item) => item.id === persisted.worktreeId) ?? null
    : findWorktreeByPath(projectState.worktrees, cwd);
  const sshProject = attach.environmentType === "ssh"
    ? projectState.projects.find((item) => (
      item.environment_type === "ssh"
      && item.ssh_host_id === attach.sshHostId
      && item.remote_path === attach.remotePath
    )) ?? null
    : null;
  const project = persisted?.projectId
    ? projectState.projects.find((item) => item.id === persisted.projectId) ?? null
    : worktree
      ? projectState.projects.find((item) => item.id === worktree.project_id) ?? null
      : sshProject ?? findProjectByPath(projectState.projects, cwd);
  const fallbackTitle = worktree?.name || project?.name || basenameFromPath(cwd) || translateCurrent("terminal.backgroundTasks.untitled");
  return {
    projectId: persisted?.projectId ?? project?.id,
    worktreeId: persisted?.worktreeId ?? worktree?.id,
    title: isGenericDaemonSessionTitle(persisted?.title) ? fallbackTitle : persisted!.title,
    cwd,
    shell: persisted?.shell ?? attach.shell,
    environmentType: persisted?.environmentType ?? (attach.environmentType === "ssh" ? "ssh" : undefined),
    sshHostId: persisted?.sshHostId ?? attach.sshHostId ?? undefined,
    remotePath: persisted?.remotePath ?? attach.remotePath ?? undefined,
    connectionState: (persisted?.environmentType === "ssh" || attach.environmentType === "ssh")
      ? (attach.alive
        ? (persisted?.connectionState === "connected" || persisted?.connectionState === "authenticating"
          ? persisted.connectionState
          : "connecting")
        : "disconnected")
      : undefined,
    disconnectReason: !attach.alive && (persisted?.environmentType === "ssh" || attach.environmentType === "ssh")
      ? persisted?.disconnectReason ?? "remote_exit"
      : persisted?.disconnectReason,
  };
}

export const SUBAGENT_CLOSE_DELAY_MS = 1500;

export const SUBAGENT_CHILD_JSONL_CLOSE_DELAY_MS = 10_000;

export const SUBAGENT_DISCOVERY_INTERVAL_MS = 1000;

export const SUBAGENT_DISCOVERY_FAST_WINDOW_MS = 15000;

export const SUBAGENT_DISCOVERY_SLOW_INTERVAL_MS = 5000;

export const SUBAGENT_DIRECTORY_DISCOVERY_TTL_MS = 15000;

export const PTY_ORPHAN_RECONCILE_INTERVAL_MS = 30_000;

export const TERMINAL_STORE_IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function summarizeStartupCmd(startupCmd?: string): string | null {
  if (!startupCmd) return null;
  const redacted = startupCmd
    .replace(/((?:token|password|passwd|secret|api[_-]?key)\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>")
    .replace(/(--(?:token|password|passwd|secret|api[_-]?key)\s+)(\S+)/gi, "$1<redacted>");
  const summary = redacted.replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 120)}...` : summary;
}

export function logTerminalExitStatus(session: TerminalSession, payload: PtyStatusPayload) {
  if (payload.status !== "exited" && payload.status !== "error") return;
  recordCrashActivity("terminal.process_exit", {
    sessionId: session.id,
    title: session.title,
    projectId: session.projectId ?? null,
    worktreeId: session.worktreeId ?? null,
    cwd: session.cwd ?? null,
    shell: session.shell ?? null,
    startupCmdSummary: summarizeStartupCmd(session.startupCmd),
    status: payload.status,
    exitCode: payload.exit_code,
  });
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

export function mapCliHookEvent(event: CliHookEventName): TabNotificationState | null {
  // SessionStart 仅用于回传 sessionId 绑定 Tab，不改变 Tab 状态
  if (event === "SessionStart") return null;
  if (event === "UserPromptSubmit") return "running";
  // Notification 经 settings.json matcher 过滤，只有 permission_prompt /
  // idle_prompt（需要用户介入）会送达
  if (event === "Notification") return "attention";
  if (event === "PermissionRequest") return "attention";
  if (event === "PermissionResult") return "running";
  if (event === "Interrupt") return "none";
  if (event === "StopFailure") return "failed";
  if (event === "Stop") return "done";
  return null;
}

export function mapShellRuntimeEvent(event: ShellRuntimeEventName, exitCode?: number | null): TabNotificationState {
  if (event === "command_started") return "running";
  if (event === "command_finished") {
    if (exitCode === 0) return "done";
    return typeof exitCode === "number" && Number.isFinite(exitCode) ? "failed" : "none";
  }
  return "none";
}

export function resolvePrimaryTabId(tabId: string, splits: Record<string, SplitState>): string {
  for (const [primaryId, split] of Object.entries(splits)) {
    if (split.secondSessionId === tabId) return primaryId;
  }
  return tabId;
}

export function getTabStatusEntry(state: TabStatusSources | undefined): TabNotificationState {
  if (!state) return "none";
  const candidates: TabNotificationState[] = [state.hook ?? "none", state.shell ?? "none"];
  return candidates.reduce((current, next) => (TAB_STATUS_PRIORITY[next] > TAB_STATUS_PRIORITY[current] ? next : current), "none");
}

export function getTabStatusDetails(state: TabStatusSources | undefined): TabStatusDetails {
  if (!state) return { status: "none", updatedAt: null };
  const hookScore = state.hook ? TAB_STATUS_PRIORITY[state.hook] : -1;
  const shellScore = state.shell ? TAB_STATUS_PRIORITY[state.shell] : -1;
  if (hookScore >= shellScore) {
    return { status: state.hook ?? "none", updatedAt: state.hookUpdatedAt ?? null };
  }
  return { status: state.shell ?? "none", updatedAt: state.shellUpdatedAt ?? null };
}

export function buildTabStatusUpdate(
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

export function applySshExitState(session: TerminalSession, payload: PtyStatusPayload): TerminalSession {
  if (session.environmentType !== "ssh" || (payload.status !== "exited" && payload.status !== "error")) {
    return session;
  }
  const wasConnected = session.connectionState === "connected";
  let disconnectReason: SshDisconnectReason;
  if (payload.status === "error") disconnectReason = "local_process_error";
  else if (payload.exit_code === 255) disconnectReason = "ssh_transport_error";
  else if (payload.exit_code === 0) disconnectReason = "remote_exit";
  else disconnectReason = "remote_command_exit";
  return {
    ...session,
    connectionState: wasConnected ? "disconnected" : "failed",
    disconnectReason,
  };
}

export function applyPtyStatusToSessions(
  sessions: TerminalSession[],
  sessionId: string,
  payload: PtyStatusPayload
): TerminalSession[] {
  return sessions.map((session) => (
    session.id === sessionId ? applySshExitState(session, payload) : session
  ));
}

export function isCliManagerSyncArtifactText(value: string): boolean {
  const text = value.toLowerCase();
  return (
    text.includes("cli-manager 同步聚合会话")
    || text.includes(".cli-manager/synced-history/")
    || text.includes("同步记录已加载")
  );
}
