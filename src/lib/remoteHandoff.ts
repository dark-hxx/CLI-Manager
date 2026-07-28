import { invoke } from "@tauri-apps/api/core";
import type { Project, SshHost, TerminalSession, WorktreeRecord } from "./types";
import type { SessionStatus, TabNotificationState } from "../stores/terminalStore";

export const REMOTE_HANDOFF_START_REQUEST_EVENT = "remote-handoff-start-request";
export const REMOTE_HANDOFF_CANCEL_REQUEST_EVENT = "remote-handoff-cancel-request";

export type CcConnectPlatform = "telegram" | "feishu" | "weixin" | "wecom";
export type CcConnectHandoffTransport = "local" | "ssh";

export interface CcConnectHandoffInfo {
  localSessionId: string;
  cliSessionId: string;
  projectId: string;
  projectName: string;
  worktreeId: string | null;
  worktreeName: string | null;
  workDir: string;
  providerId: string | null;
  providerName: string;
  platform: CcConnectPlatform;
  startedAtMs: number;
  transport: CcConnectHandoffTransport;
  sshHostId: string | null;
  remotePath: string | null;
}

export interface CcConnectHandoffStatus {
  active: boolean;
  running: boolean;
  info: CcConnectHandoffInfo | null;
  warning: string | null;
}

export interface CcConnectHandoffStartRequest {
  localSessionId: string;
  cliSessionId: string;
  platform: CcConnectPlatform;
  projectId: string;
  worktreeId: string | null;
  workDir: string;
  sessionTitle: string | null;
}

export interface CcConnectHandoffPlatformTarget {
  platform: CcConnectPlatform;
  enabled: boolean;
  credentialsReady: boolean;
  sessionReady: boolean;
  ready: boolean;
  unavailableReason: string | null;
}

export type RemoteHandoffEligibilityReason =
  | "already_handed_off"
  | "another_session_handed_off"
  | "codex_only"
  | "missing_cli_session_id"
  | "missing_project"
  | "missing_work_dir"
  | "worktree_missing"
  | "ssh_worktree_unsupported"
  | "ssh_host_missing"
  | "ssh_interactive_auth_unsupported"
  | "path_unsupported"
  | "task_running"
  | "task_state_unknown"
  | "unsupported_session";

export interface RemoteHandoffEligibility {
  eligible: boolean;
  reason: RemoteHandoffEligibilityReason | null;
}

export function isCodexSession(session: TerminalSession, project: Project | undefined): boolean {
  const configured = project?.cli_tool.trim().toLowerCase() ?? "";
  if (configured === "codex" || configured.includes("codex")) return true;
  return /(?:^|\s)codex(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i.test(session.startupCmd?.trim() ?? "");
}

export function getRemoteHandoffWorkDir(
  session: TerminalSession,
  project: Project | undefined
): string {
  if (project?.environment_type === "ssh") {
    return session.remotePath?.trim() || project.remote_path.trim();
  }
  return session.cwd?.trim() ?? "";
}

export function getRemoteHandoffEligibility(input: {
  session: TerminalSession;
  project?: Project;
  sshHost?: SshHost;
  worktree?: WorktreeRecord | null;
  notification: TabNotificationState;
  processStatus?: SessionStatus;
  activeHandoff: CcConnectHandoffInfo | null;
}): RemoteHandoffEligibility {
  const { session, project, sshHost, worktree, notification, processStatus, activeHandoff } = input;
  if (session.remoteHandoff) return { eligible: false, reason: "already_handed_off" };
  if (activeHandoff) return { eligible: false, reason: "another_session_handed_off" };
  if ((session.kind ?? "pty") !== "pty") return { eligible: false, reason: "unsupported_session" };
  if (!project) return { eligible: false, reason: "missing_project" };
  if (!isCodexSession(session, project)) return { eligible: false, reason: "codex_only" };
  if (project.environment_type === "wsl") {
    return { eligible: false, reason: "path_unsupported" };
  }
  if (!getRemoteHandoffWorkDir(session, project)) {
    return { eligible: false, reason: "missing_work_dir" };
  }
  if (project.environment_type === "ssh") {
    if (session.worktreeId) {
      return { eligible: false, reason: "ssh_worktree_unsupported" };
    }
    if (!project.ssh_host_id?.trim() || !sshHost || sshHost.id !== project.ssh_host_id) {
      return { eligible: false, reason: "ssh_host_missing" };
    }
    if (sshHost.auth_mode === "password_prompt" || sshHost.auth_mode === "interactive") {
      return { eligible: false, reason: "ssh_interactive_auth_unsupported" };
    }
  }
  if (session.worktreeId && (!worktree || worktree.status !== "active")) {
    return { eligible: false, reason: "worktree_missing" };
  }
  if (notification === "running" || notification === "attention") {
    return { eligible: false, reason: "task_running" };
  }
  if (
    notification !== "done"
    && notification !== "failed"
    && processStatus !== "exited"
    && processStatus !== "error"
  ) {
    return { eligible: false, reason: "task_state_unknown" };
  }
  const cliSessionId = session.cliSessionId?.trim();
  if (!cliSessionId || /\s/.test(cliSessionId)) {
    return { eligible: false, reason: "missing_cli_session_id" };
  }
  return { eligible: true, reason: null };
}

export async function fetchRemoteHandoffStatus(): Promise<CcConnectHandoffStatus> {
  return invoke<CcConnectHandoffStatus>("cc_connect_handoff_status");
}

export async function fetchRemoteHandoffPlatforms(): Promise<CcConnectHandoffPlatformTarget[]> {
  return invoke<CcConnectHandoffPlatformTarget[]>("cc_connect_handoff_platforms");
}

export async function startRemoteHandoff(
  request: CcConnectHandoffStartRequest
): Promise<CcConnectHandoffStatus> {
  return invoke<CcConnectHandoffStatus>("cc_connect_handoff_start", { request });
}

export async function preflightRemoteHandoff(
  request: CcConnectHandoffStartRequest
): Promise<void> {
  return invoke<void>("cc_connect_handoff_preflight", { request });
}

export async function cancelRemoteHandoff(): Promise<CcConnectHandoffStatus> {
  return invoke<CcConnectHandoffStatus>("cc_connect_handoff_cancel");
}
