export type AuthUser = { id: string; username: string };

export type AuthStatus = {
  authenticated: boolean;
  user: AuthUser | null;
  deviceScope?: string | null;
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
  clientId: string;
  machineId: string | null;
  clientKind: "development" | "release" | null;
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
  projectId?: string | null;
  worktreeId?: string | null;
  title: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  branch: string | null;
  freshness: Freshness;
};

export type WorkspaceGroup = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
};

export type WorkspaceProject = {
  id: string;
  name: string;
  groupId: string | null;
  sortOrder: number;
  source: "claude" | "codex" | null;
  cwd: string | null;
  environmentType: "local" | "wsl" | "ssh";
};

export type WorkspaceWorktree = {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  cwd: null;
  status: "active" | "missing";
};

export type WebSubagentSnapshot = {
  sessionId: string;
  parentSessionId: string;
  title: string;
  sourceKind: string;
  ended: boolean;
  content: string;
  truncated: boolean;
};

export type WorkspaceSnapshot = {
  subagents?: WebSubagentSnapshot[] | null;
  terminals?: Array<{ sessionId: string; projectId: string; worktreeId: string | null; title: string }> | null;
  groups: WorkspaceGroup[];
  projects: WorkspaceProject[];
  worktrees: WorkspaceWorktree[];
  updatedAt: number;
};

export type ProjectContext = {
  key: string;
  source: string;
  projectKey: string;
  projectName: string;
  cwd: string | null;
  branch: string | null;
  title: string;
  freshness: Freshness;
  projectId?: string;
  worktreeId?: string;
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
  | { id: string; type: "assistant" | "activity"; text: string; occurredAt: number; streaming?: boolean }
  | { id: string; type: "operation"; operation: Operation };

export type ConversationEvent = {
  operationId: string; sessionId: string; source: string; projectId: string;
  worktreeId?: string | null; sequence: number; kind: string;
  messageId?: string | null; text?: string | null; occurredAt: number;
};
export type BrowserSession = { id: string; deviceId: string; name: string; createdAt: number; lastSeenAt: number; expiresAt: number };

export type BrowserEventPayload =
  | { type: "conversation.updated"; deviceId: string; event: ConversationEvent }
  | { type: "device.updated"; device: Device }
  | { type: "operation.updated"; operation: Operation }
  | { type: "history.updated"; deviceId: string; latestUpdatedAt: number }
  | { type: "workspace.updated"; deviceId: string; workspace: WorkspaceSnapshot }
  | { type: "pairing.updated"; pairingId: string; status: string; deviceId: string };

export type BrowserMessage =
  | { type: "heartbeat" }
  | { type: "ready"; latestSequence: number }
  | { type: "event"; sequence: number; occurredAt: number; payload: BrowserEventPayload }
  | { type: "terminal_output"; deviceId: string; sessionId: string; sequence: number; frames: TerminalOutputFrame[] }
  | { type: "terminal_status"; deviceId: string; sessionId: string; status: string; exitCode?: number; controlMode?: TerminalControlMode }
  | { type: "error"; code: string; message: string };

export type TerminalControlMode = "desktop" | "web";
export type WebTerminalTab = {
  sessionId: string;
  contextKey: string;
  status: string;
  controlMode: TerminalControlMode;
};
export type TerminalOutputFrame = {
  sequenceEnd?: boolean;
  sequenceStart?: boolean;
  sequence: number;
  cols: number;
  rows: number;
  data: string;
  kind: "output" | "replay" | "reset";
  replayBatchEnd: boolean;
};
export type TerminalChunk = {
  sequence: number;
  frames: TerminalOutputFrame[];
};

export type BrowserTerminalCommand =
  | { type: "attach"; sessionId: string; afterSequence?: number }
  | { type: "detach"; sessionId: string }
  | { type: "close"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number };

export type LoadState = "idle" | "loading" | "ready" | "error";
