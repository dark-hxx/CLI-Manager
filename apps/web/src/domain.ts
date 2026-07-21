export type AuthUser = { id: string; username: string };

export type AuthStatus = {
  authenticated: boolean;
  user: AuthUser | null;
};

export type DeviceStatus = "online" | "offline";

export type DeviceHostInfo = {
  hostName: string;
  osVersion: string;
  cpuArch: string;
  cpuModel: string;
  totalMemoryBytes: number;
  displayWidth: number;
  displayHeight: number;
};

export type Device = {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  status: DeviceStatus;
  lastSeenAt: number | string | null;
  pairedAt: number | string | null;
  capabilities: string[];
  hostInfo: DeviceHostInfo | null;
  wallpaperRevision: string | null;
};

export type Pairing = {
  id: string;
  status: "claimed";
  expiresAt: number | string;
};

export type PairingState =
  | { status: "idle" }
  | { status: "submitting"; code: string }
  | { status: "claimed"; pairing: Pairing; device: Device }
  | { status: "error"; code: string; message: string; input: string };

export type Freshness = "live" | "cached" | "stale";

export type HistorySessionSummary = {
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
  freshness: Freshness;
};

export type ProjectContext = {
  key: string;
  source: string;
  projectKey: string;
  cwd: string;
  branch: string | null;
  title: string;
  freshness: Freshness;
};

export type OperationStatus =
  | "submitted"
  | "waiting_device"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "timed_out"
  | "canceled";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type Operation = {
  id: string;
  deviceId: string;
  kind: string;
  status: OperationStatus;
  idempotencyKey: string;
  payload: JsonValue;
  result: JsonValue;
  error: { code: string; message: string } | null;
  createdAt: number | string;
  updatedAt: number | string;
};

export type TimelineItem =
  | { id: string; type: "prompt"; text: string; occurredAt: number }
  | { id: string; type: "operation"; operation: Operation };

export type BrowserEventPayload =
  | { type: "device.updated"; device: Device }
  | { type: "operation.updated"; operation: Operation }
  | { type: "history.updated"; deviceId: string; latestUpdatedAt: number }
  | { type: "pairing.updated"; pairingId: string; status: string; deviceId: string };

export type BrowserMessage =
  | { type: "ready"; latestSequence: number }
  | { type: "event"; sequence: number; occurredAt: number; payload: BrowserEventPayload }
  | { type: "error"; code: string; message: string };

export type LoadState = "idle" | "loading" | "ready" | "error";
