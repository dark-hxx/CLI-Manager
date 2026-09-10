import { invoke } from "@tauri-apps/api/core";

export interface WebDeviceProfile {
  serverUrl: string;
  trustedNetwork: boolean;
  publicAccessUrl: string;
  clientId: string;
  machineId: string;
  clientKind: "development" | "release";
  name: string;
  autoStart: boolean;
  uploadWallpaper: boolean;
  capabilities: string[];
}

export interface WebDeviceStatus {
  configured: boolean;
  running: boolean;
  connected: boolean;
  paired: boolean;
  profile: WebDeviceProfile | null;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  pendingOperations: number;
  lastError: string | null;
}

export interface WebDeviceProfileInput {
  serverUrl: string;
  trustedNetwork: boolean;
  publicAccessUrl: string;
  name: string;
  autoStart: boolean;
  uploadWallpaper: boolean;
}

export interface WebDeviceOperation {
  id: string;
  deviceId: string;
  kind: "conversation.start" | "conversation.prompt" | string;
  status: string;
  idempotencyKey: string;
  payload: unknown;
  result: unknown;
  error: { code: string; message: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface WebWorkspaceSnapshot {
  terminals?: Array<{ sessionId: string; projectId: string; worktreeId: string | null; title: string }>;
  groups: Array<{ id: string; name: string; parentId: string | null; sortOrder: number }>;
  projects: Array<{
    id: string;
    name: string;
    groupId: string | null;
    sortOrder: number;
    source: "claude" | "codex" | null;
    cwd?: string | null;
    environmentType: "local" | "wsl" | "ssh";
  }>;
  worktrees: Array<{
    id: string;
    projectId: string;
    name: string;
    branch: string;
    cwd?: string | null;
    status: "active" | "missing";
  }>;
  updatedAt: number;
}

export type WebTerminalCommand =
  | { type: "attach"; sessionId: string; afterSequence?: number }
  | { type: "detach"; sessionId: string }
  | { type: "close"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number };

export interface WebTerminalOutputFrame {
  sequence: number;
  cols: number;
  rows: number;
  data: string;
  kind: "output" | "replay" | "reset";
  replayBatchEnd: boolean;
}

export interface WebHistorySessionSummary {
  sessionId: string;
  deviceId: string;
  source: string;
  projectKey: string;
  projectId?: string | null;
  worktreeId?: string | null;
  title: string;
  cwd?: null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  branch: string | null;
  freshness: string;
}

export const webDeviceApi = {
  getStatus: () => invoke<WebDeviceStatus>("web_device_get_status"),
  saveProfile: (request: WebDeviceProfileInput) => invoke<WebDeviceStatus>("web_device_save_profile", { request }),
  start: () => invoke<WebDeviceStatus>("web_device_start"),
  stop: () => invoke<WebDeviceStatus>("web_device_stop"),
  restart: () => invoke<WebDeviceStatus>("web_device_restart"),
  createPairing: () => invoke<{ code: string; expiresAt: number }>("web_device_create_pairing"),
  clearPairing: () => invoke<WebDeviceStatus>("web_device_clear_pairing"),
  mobileTicket: (revoke = false) => invoke<{ url: string; expiresAt: number } | null>("web_device_mobile_ticket", { revoke }),
  takeOperations: () => invoke<WebDeviceOperation[]>("web_device_take_operations"),
  takeTerminalCommands: () => invoke<WebTerminalCommand[]>("web_device_take_terminal_commands"),
  terminalOutput: (
    sessionId: string,
    sequence: number,
    frames: WebTerminalOutputFrame[],
  ) => invoke<void>("web_device_terminal_output", {
    request: { sessionId, sequence, frames },
  }),
  terminalStatus: (
    sessionId: string,
    status: string,
    exitCode: number | null = null,
    controlMode?: "desktop" | "web",
  ) => invoke<void>("web_device_terminal_status", {
    request: { sessionId, status, exitCode, controlMode },
  }),
  publishWorkspace: (workspace: WebWorkspaceSnapshot, sessions: WebHistorySessionSummary[] = []) =>
    invoke<void>("web_device_publish_history", { request: { sessions, workspace } }),
  validateContext: (rootPath: string, cwd: string) => invoke<void>("web_device_validate_context", { request: { rootPath, cwd } }),
  accepted: (operationId: string) => invoke<void>("web_device_operation_accepted", { request: { operationId } }),
  running: (operationId: string) => invoke<void>("web_device_operation_running", { request: { operationId } }),
  completed: (
    operationId: string,
    status: "succeeded" | "failed" | "rejected" | "timed_out" | "canceled",
    result: unknown = null,
    error: { code: string; message: string } | null = null,
  ) => invoke<void>("web_device_operation_completed", { request: { operationId, status, result, error } }),
};
