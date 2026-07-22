import { invoke } from "@tauri-apps/api/core";
import type { Project, TerminalSession, WorktreeRecord } from "./types";
import type { SessionStatus, TabNotificationState } from "../stores/terminalStore";

export const REMOTE_HANDOFF_START_REQUEST_EVENT = "remote-handoff-start-request";
export const REMOTE_HANDOFF_CANCEL_REQUEST_EVENT = "remote-handoff-cancel-request";

export type CcConnectPlatform = "telegram" | "feishu" | "weixin" | "wecom";

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
  | "task_running"
  | "task_state_unknown"
  | "unsupported_session";

export interface RemoteHandoffEligibility {
  eligible: boolean;
  reason: RemoteHandoffEligibilityReason | null;
}

function isCodexSession(session: TerminalSession, project: Project | undefined): boolean {
  const configured = project?.cli_tool.trim().toLowerCase() ?? "";
  if (configured === "codex" || configured.includes("codex")) return true;
  return /(?:^|\s)codex(?:\.(?:cmd|exe|ps1))?(?:\s|$)/i.test(session.startupCmd?.trim() ?? "");
}

export function getRemoteHandoffEligibility(input: {
  session: TerminalSession;
  project?: Project;
  worktree?: WorktreeRecord | null;
  notification: TabNotificationState;
  processStatus?: SessionStatus;
  activeHandoff: CcConnectHandoffInfo | null;
}): RemoteHandoffEligibility {
  const { session, project, worktree, notification, processStatus, activeHandoff } = input;
  if (session.remoteHandoff) return { eligible: false, reason: "already_handed_off" };
  if (activeHandoff) return { eligible: false, reason: "another_session_handed_off" };
  if ((session.kind ?? "pty") !== "pty") return { eligible: false, reason: "unsupported_session" };
  if (!project) return { eligible: false, reason: "missing_project" };
  if (!isCodexSession(session, project)) return { eligible: false, reason: "codex_only" };
  const cliSessionId = session.cliSessionId?.trim();
  if (!cliSessionId || /\s/.test(cliSessionId)) {
    return { eligible: false, reason: "missing_cli_session_id" };
  }
  if (!session.cwd?.trim()) return { eligible: false, reason: "missing_work_dir" };
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

export async function cancelRemoteHandoff(): Promise<CcConnectHandoffStatus> {
  return invoke<CcConnectHandoffStatus>("cc_connect_handoff_cancel");
}
