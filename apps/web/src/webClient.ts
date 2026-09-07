import type {
  AuthStatus,
  BrowserMessage,
  Device,
  HistorySessionSummary,
  JsonObject,
  Operation,
  Pairing,
  WorkspaceSnapshot,
} from "./domain";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as T & {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new ApiError(body.error?.code ?? "request_failed", body.error?.message ?? response.statusText, response.status);
  }
  return body;
}

export const webClient = {
  authStatus: () => request<AuthStatus>("/auth/status"),
  login: (username: string, password: string) =>
    request<AuthStatus>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  devices: () => request<{ devices: Device[] }>("/devices"),
  removeDevice: (deviceId: string) => request<{ ok: true }>(`/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }),
  claimPairing: (code: string) =>
    request<{ pairing: Pairing; device: Device }>("/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  history: (deviceId: string, limit = 50, offset = 0) => {
    const query = new URLSearchParams({ deviceId, limit: String(limit), offset: String(offset) });
    return request<{ items: HistorySessionSummary[]; nextOffset: number | null; workspace: WorkspaceSnapshot | null }>(`/history?${query}`);
  },
  createOperation: (input: {
    deviceId: string;
    kind: string;
    idempotencyKey: string;
    payload: JsonObject;
  }) => request<{ operation: Operation }>("/operations", { method: "POST", body: JSON.stringify(input) }),
};

export function deviceWallpaperUrl(device: Pick<Device, "id" | "wallpaperRevision">): string | null {
  if (!device.wallpaperRevision) return null;
  return `/api/devices/${encodeURIComponent(device.id)}/wallpaper?revision=${encodeURIComponent(device.wallpaperRevision)}`;
}

type BrowserSocketOptions = {
  afterSequence: () => number;
  onMessage: (message: BrowserMessage) => void;
  onState: (state: "connecting" | "open" | "closed") => void;
  onUnauthorized: () => void;
};

export function connectBrowserSocket(options: BrowserSocketOptions): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let retry = 0;

  const open = () => {
    if (stopped) return;
    options.onState("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws/browser?afterSequence=${options.afterSequence()}`);
    socket.onopen = () => {
      retry = 0;
      options.onState("open");
    };
    socket.onmessage = (event) => {
      try {
        options.onMessage(JSON.parse(event.data) as BrowserMessage);
      } catch {
        // Ignore malformed frames; the next persisted sequence remains eligible for replay.
      }
    };
    socket.onclose = (event) => {
      options.onState("closed");
      if (stopped) return;
      if (event.code === 1008 || event.code === 4401) {
        options.onUnauthorized();
        return;
      }
      const delay = Math.min(1_000 * 2 ** retry++, 15_000);
      retryTimer = window.setTimeout(open, delay);
    };
  };

  open();
  return () => {
    stopped = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    socket?.close();
  };
}
