import { invoke } from "@tauri-apps/api/core";

export interface WebDeviceProfile {
  serverUrl: string;
  deviceId: string;
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

export interface WebHistorySessionSummary {
  sessionId: string;
  deviceId: string;
  source: string;
  projectKey: string;
  title: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  branch: string | null;
  freshness: "live";
}

export const webDeviceApi = {
  getStatus: () => invoke<WebDeviceStatus>("web_device_get_status"),
  saveProfile: (request: WebDeviceProfileInput) => invoke<WebDeviceStatus>("web_device_save_profile", { request }),
  start: () => invoke<WebDeviceStatus>("web_device_start"),
  stop: () => invoke<WebDeviceStatus>("web_device_stop"),
  restart: () => invoke<WebDeviceStatus>("web_device_restart"),
  createPairing: () => invoke<{ code: string; expiresAt: number }>("web_device_create_pairing"),
  clearPairing: () => invoke<WebDeviceStatus>("web_device_clear_pairing"),
  takeOperations: () => invoke<WebDeviceOperation[]>("web_device_take_operations"),
  publishHistory: (sessions: WebHistorySessionSummary[]) => invoke<void>("web_device_publish_history", { request: { sessions } }),
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
