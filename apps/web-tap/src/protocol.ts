import { webRequest, ApiError } from "../../../src/shared/lib/webBrowserHttp";
export { ApiError };
export { connectBrowserSocket } from "../../../src/shared/lib/webBrowserSocket";
export { createTerminalStream } from "../../../src/shared/lib/webTerminalStream";
export type { BrowserSocketConnection } from "../../../src/shared/lib/webBrowserSocket";
export type { TerminalStream } from "../../../src/shared/lib/webTerminalStream";
export type {
  AuthStatus, AuthUser, Device, WorkspaceSnapshot, WorkspaceProject, WorkspaceWorktree,
  Operation, JsonObject, JsonValue, BrowserMessage, TerminalControlMode, TerminalOutputFrame,
} from "../../../src/shared/types/webBrowser";
import type { AuthStatus, Device, WorkspaceSnapshot, Operation, JsonObject } from "../../../src/shared/types/webBrowser";

/** No path, command line or native secret is part of a browser project request. */
export const api = {
  auth: () => webRequest<AuthStatus>("/auth/status"),
  login: (username: string, password: string) => webRequest<AuthStatus>("/auth/login", {
    method: "POST", body: JSON.stringify({ username, password }),
  }),
  logout: () => webRequest("/auth/logout", { method: "POST" }),
  redeem: (token: string) => webRequest<AuthStatus>("/mobile/redeem", {
    method: "POST", body: JSON.stringify({ token, name: "Tap Web" }),
  }),
  devices: () => webRequest<{ devices: Device[] }>("/devices"),
  pair: (code: string) => webRequest("/pairing/claim", { method: "POST", body: JSON.stringify({ code }) }),
  workspace: (deviceId: string, signal?: AbortSignal) => webRequest<{ workspace: WorkspaceSnapshot | null }>(
    `/history?${new URLSearchParams({ deviceId, limit: "1" })}`, { signal },
  ),
  createOperation: (deviceId: string, kind: string, payload: JsonObject, idempotencyKey: string, signal?: AbortSignal) =>
    webRequest<{ operation: Operation }>("/operations", {
      method: "POST", signal, body: JSON.stringify({ deviceId, kind, payload, idempotencyKey }),
    }),
  operation: (id: string, signal?: AbortSignal) => webRequest<{ operation: Operation }>(`/operations/${encodeURIComponent(id)}`, { signal }),
};
