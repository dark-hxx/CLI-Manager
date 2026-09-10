import type {
  AuthStatus,
  BrowserSession,
  ConversationEvent,
  BrowserMessage,
  BrowserTerminalCommand,
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
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
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
  redeemMobile: (token: string, name: string) => request<AuthStatus>("/mobile/redeem", { method: "POST", body: JSON.stringify({ token, name }) }),
  browserSessions: () => request<{ sessions: BrowserSession[] }>("/mobile/sessions"),
  mobileTicket: (deviceId: string) => request<{ token: string; expiresAt: number }>("/mobile/tickets", { method: "POST", body: JSON.stringify({ deviceId }) }),
  stopMobileTicket: (deviceId: string) => request<{ ok: true }>(`/mobile/tickets/${encodeURIComponent(deviceId)}`, { method: "DELETE" }),
  revokeBrowser: (id: string) => request<{ ok: true }>(`/mobile/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  conversations: (deviceId: string, signal?: AbortSignal) => request<{ sessions: HistorySessionSummary[] }>(`/conversations?${new URLSearchParams({ deviceId })}`, { signal }),
  conversation: (deviceId: string, sessionId: string) => request<{ events: ConversationEvent[] }>(`/conversations/${encodeURIComponent(sessionId)}?${new URLSearchParams({ deviceId })}`),
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
  history: (deviceId: string, limit = 50, offset = 0, signal?: AbortSignal) => {
    const query = new URLSearchParams({ deviceId, limit: String(limit), offset: String(offset) });
    return request<{ items: HistorySessionSummary[]; nextOffset: number | null; workspace: WorkspaceSnapshot | null }>(`/history?${query}`, { signal });
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
  onMessage: (message: Exclude<BrowserMessage, { type: "heartbeat" }>) => void;
  onState: (state: "connecting" | "open" | "closed") => void;
  onUnauthorized: () => void;
};

export type BrowserSocketConnection = {
  close: () => void;
  sendTerminal: (deviceId: string, command: BrowserTerminalCommand) => boolean;
};

export function connectBrowserSocket(options: BrowserSocketOptions): BrowserSocketConnection {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let connectTimer: number | null = null;
  let idleTimer: number | null = null;
  let retry = 0;

  const clearTimers = () => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    if (connectTimer !== null) window.clearTimeout(connectTimer);
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    retryTimer = null;
    connectTimer = null;
    idleTimer = null;
  };
  const discardSocket = () => {
    const oldSocket = socket;
    socket = null;
    if (!oldSocket) return;
    oldSocket.onopen = null;
    oldSocket.onmessage = null;
    oldSocket.onclose = null;
    oldSocket.onerror = null;
    oldSocket.close();
  };
  const reconnect = (code?: number) => {
    clearTimers();
    discardSocket();
    if (stopped) return;
    options.onState("closed");
    if (code === 1008 || code === 4401) {
      stopped = true;
      options.onUnauthorized();
      return;
    }
    retryTimer = window.setTimeout(open, Math.min(1_000 * 2 ** Math.min(retry++, 4), 15_000));
  };
  const open = () => {
    if (stopped) return;
    clearTimers();
    options.onState("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(`${protocol}//${location.host}/ws/browser?afterSequence=${options.afterSequence()}`);
    socket = current;
    const active = () => !stopped && socket === current;
    let ready = false;
    // A TCP/WebSocket handshake (or missing ready frame) must not strand reconnect.
    connectTimer = window.setTimeout(() => { if (active()) reconnect(); }, 10_000);
    current.onopen = () => {
      if (!active()) return;
      options.onState("open");
    };
    current.onmessage = (event) => {
      if (!active()) return;
      let message: BrowserMessage;
      try {
        message = JSON.parse(event.data) as BrowserMessage;
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || !["ready", "heartbeat", "event", "terminal_output", "terminal_status", "error"].includes(message.type)) return;
      if (message.type === "ready") {
        ready = true;
        if (connectTimer !== null) window.clearTimeout(connectTimer);
        connectTimer = null;
        retry = 0;
      }
      if (ready) {
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => { if (active()) reconnect(); }, 45_000);
      }
      if (message.type === "heartbeat") return;
      options.onMessage(message);
    };
    current.onclose = (event) => { if (active()) reconnect(event.code); };
    // Browsers follow error with close; preserve its authorization close code.
    // The deadline above also covers a connection that never reaches close.
  };

  open();
  const resume = () => {
    if (document.visibilityState === "hidden" || stopped) return;
    clearTimers();
    discardSocket();
    open();
  };
  window.addEventListener("online", resume);
  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", resume);
  return {
    sendTerminal: (deviceId, command) => {
      if (stopped || socket?.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(JSON.stringify({ type: "terminal_command", deviceId, command }));
        return true;
      } catch {
        reconnect();
        return false;
      }
    },
    close: () => {
      stopped = true;
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
      clearTimers();
      discardSocket();
    },
  };
}
