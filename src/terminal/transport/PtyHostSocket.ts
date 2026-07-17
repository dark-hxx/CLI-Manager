import { invoke } from "@tauri-apps/api/core";

const BINARY_PROTOCOL_VERSION = 1;
const BINARY_KIND_OUTPUT = 1;
const BINARY_KIND_REPLAY = 2;
const BINARY_HEADER_BYTES = 20;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface PtyHostEndpoint {
  url: string;
  token: string;
  protocolVersion: number;
  daemonVersion: string;
}

interface PendingRequest {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

export interface TerminalBinaryFrame {
  kind: "output" | "replay";
  sessionId: string;
  sequence: number;
  cols: number;
  rows: number;
  data: Uint8Array;
  replayBatchEnd?: boolean;
}

export interface PtyHostAttachResult {
  attached: boolean;
  alive: boolean;
  replay: TerminalBinaryFrame[];
  cwd?: string | null;
  shell?: string | null;
  createdAtMs?: number;
  taskStatus?: string | null;
  taskUpdatedAtMs?: number | null;
}

export interface PtyHostStatusEvent {
  status: string;
  exit_code: number | null;
}

type OutputListener = (frame: TerminalBinaryFrame) => void;
type StatusListener = (event: PtyHostStatusEvent) => void;

export class PtyHostSocket {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly outputListeners = new Map<string, Set<OutputListener>>();
  private readonly statusListeners = new Map<string, Set<StatusListener>>();
  private readonly pendingOutput = new Map<string, TerminalBinaryFrame[]>();
  private readonly pendingStatus = new Map<string, PtyHostStatusEvent>();
  private readonly replayFrames = new Map<string, TerminalBinaryFrame[]>();
  private readonly latestReceivedSequence = new Map<string, number>();
  private readonly latestCommittedSequence = new Map<string, number>();
  private readonly attachedSessions = new Set<string>();
  private readonly closedSessions = new Set<string>();
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private lastPongAt = 0;

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async write(sessionId: string, data: string): Promise<void> {
    await this.request({ type: "write", session_id: sessionId, data });
  }

  async create(
    sessionId: string,
    cwd: string | null,
    envVars: Record<string, string>,
    shell: string | null,
  ): Promise<void> {
    this.closedSessions.delete(sessionId);
    this.attachedSessions.add(sessionId);
    this.latestReceivedSequence.set(sessionId, 0);
    this.latestCommittedSequence.set(sessionId, 0);
    try {
      await this.request({
        type: "create",
        session_id: sessionId,
        cwd,
        env_vars: envVars,
        shell,
      });
    } catch (error) {
      try {
        await this.connect();
        const recovered = await this.attach(sessionId);
        if (recovered.attached) {
          this.queueReplay(sessionId, recovered.replay);
          return;
        }
      } catch {
        // Preserve the original create error after the recovery probe fails.
      }
      this.clearSession(sessionId);
      throw error;
    }
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request({ type: "resize", session_id: sessionId, cols, rows });
  }

  async close(sessionId: string): Promise<void> {
    this.closedSessions.add(sessionId);
    this.clearSession(sessionId);
    await this.request({ type: "close", session_id: sessionId });
  }

  async closeAll(): Promise<void> {
    this.attachedSessions.forEach((sessionId) => this.closedSessions.add(sessionId));
    this.pendingOutput.clear();
    this.pendingStatus.clear();
    this.replayFrames.clear();
    this.latestReceivedSequence.clear();
    this.latestCommittedSequence.clear();
    this.attachedSessions.clear();
    this.cancelReconnectWhenIdle();
    await this.request({ type: "close_all" });
  }

  async attach(sessionId: string): Promise<PtyHostAttachResult> {
    if (this.closedSessions.has(sessionId)) {
      return { attached: false, alive: false, replay: [] };
    }
    this.replayFrames.set(sessionId, []);
    this.attachedSessions.add(sessionId);
    try {
      const frame = await this.request({ type: "attach", session_id: sessionId });
      const meta = (frame.meta ?? {}) as Record<string, unknown>;
      const latestSequence = Number(frame.latest_sequence ?? 0);
      this.latestReceivedSequence.set(sessionId, latestSequence);
      return {
        attached: true,
        alive: meta.alive === true,
        replay: this.replayFrames.get(sessionId) ?? [],
        cwd: typeof meta.cwd === "string" ? meta.cwd : null,
        shell: typeof meta.shell === "string" ? meta.shell : null,
        createdAtMs: Number(meta.createdAtMs ?? 0),
        taskStatus: typeof meta.taskStatus === "string" ? meta.taskStatus : null,
        taskUpdatedAtMs: meta.taskUpdatedAtMs == null ? null : Number(meta.taskUpdatedAtMs),
      };
    } catch {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.attachedSessions.delete(sessionId);
      } else if (this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          void this.reconnectAttachedSessions();
        }, 1_000);
      }
      return { attached: false, alive: false, replay: [] };
    } finally {
      this.replayFrames.delete(sessionId);
    }
  }

  queueReplay(sessionId: string, replay: TerminalBinaryFrame[]): void {
    if (replay.length === 0) return;
    const replayBatch = replay.map((frame, index) => ({
      ...frame,
      kind: "replay" as const,
      replayBatchEnd: index === replay.length - 1,
    }));
    const listeners = this.outputListeners.get(sessionId);
    if (listeners?.size) {
      replayBatch.forEach((frame) => listeners.forEach((listener) => listener(frame)));
      return;
    }
    const pending = this.pendingOutput.get(sessionId) ?? [];
    pending.push(...replayBatch);
    this.pendingOutput.set(sessionId, pending);
  }

  subscribeOutput(sessionId: string, listener: OutputListener): () => void {
    let listeners = this.outputListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.outputListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    const pending = this.pendingOutput.get(sessionId);
    if (pending?.length) {
      this.pendingOutput.delete(sessionId);
      queueMicrotask(() => pending.forEach(listener));
    }
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.outputListeners.delete(sessionId);
    };
  }

  subscribeStatus(sessionId: string, listener: StatusListener): () => void {
    let listeners = this.statusListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.statusListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    const pending = this.pendingStatus.get(sessionId);
    if (pending) {
      this.pendingStatus.delete(sessionId);
      queueMicrotask(() => listener(pending));
    }
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.statusListeners.delete(sessionId);
    };
  }

  acknowledge(sessionId: string, sequence: number, charCount: number): void {
    if (sequence <= 0 || this.closedSessions.has(sessionId)) return;
    const previous = this.latestCommittedSequence.get(sessionId) ?? 0;
    if (sequence > previous) this.latestCommittedSequence.set(sessionId, sequence);
    if (charCount <= 0 || this.socket?.readyState !== WebSocket.OPEN) return;
    this.send({
      type: "ack",
      id: this.nextRequestId++,
      session_id: sessionId,
      sequence,
      char_count: charCount,
    });
  }

  private async openSocket(): Promise<void> {
    const endpoint = await invoke<PtyHostEndpoint | null>("pty_host_get_endpoint");
    if (!endpoint || endpoint.protocolVersion !== BINARY_PROTOCOL_VERSION) {
      throw new Error("PtyHost WebSocket endpoint unavailable");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint.url);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      let authenticated = false;
      let authSettled = false;
      const authTimeoutId = window.setTimeout(() => {
        if (authSettled) return;
        authSettled = true;
        reject(new Error("PtyHost authentication timed out"));
        socket.close();
      }, AUTH_TIMEOUT_MS);
      const rejectAuth = (error: Error) => {
        if (authSettled) return;
        authSettled = true;
        window.clearTimeout(authTimeoutId);
        reject(error);
      };
      const fail = (error: Error) => {
        if (!authenticated) rejectAuth(error);
        this.handleDisconnect(error, socket);
      };
      socket.onopen = () => {
        this.send({
          type: "auth",
          token: endpoint.token,
          client_version: endpoint.daemonVersion,
        });
      };
      socket.onmessage = (event) => {
        try {
          if (typeof event.data === "string") {
            const frame = JSON.parse(event.data) as Record<string, unknown>;
            if (frame.type === "auth_ok") {
              authenticated = true;
              authSettled = true;
              window.clearTimeout(authTimeoutId);
              this.startHeartbeat();
              resolve();
              return;
            }
            if (frame.type === "auth_err") {
              fail(new Error(String(frame.reason ?? "PtyHost authentication failed")));
              socket.close();
              return;
            }
            this.handleControlFrame(frame);
            return;
          }
          if (event.data instanceof ArrayBuffer) {
            this.handleBinaryFrame(event.data);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          socket.close();
        }
      };
      socket.onerror = () => fail(new Error("PtyHost WebSocket connection failed"));
      socket.onclose = () => fail(new Error("PtyHost WebSocket disconnected"));
    });
  }

  private async request(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        pending.reject(new Error(`PtyHost request timed out: ${String(frame.type ?? "unknown")}`));
        this.socket?.close();
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timeoutId });
      try {
        this.send({ ...frame, id });
      } catch (error) {
        const pending = this.pendingRequests.get(id);
        if (pending) window.clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("PtyHost WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(frame));
  }

  private handleControlFrame(frame: Record<string, unknown>): void {
    if (frame.type === "pong") {
      this.lastPongAt = Date.now();
    }
    if (frame.type === "exit") {
      const sessionId = String(frame.session_id ?? "");
      if (!sessionId || this.closedSessions.has(sessionId)) return;
      const event: PtyHostStatusEvent = {
        status: "exited",
        exit_code: frame.exit_code == null ? null : Number(frame.exit_code),
      };
      const listeners = this.statusListeners.get(sessionId);
      if (listeners?.size) listeners.forEach((listener) => listener(event));
      else this.pendingStatus.set(sessionId, event);
      return;
    }

    const id = Number(frame.id ?? 0);
    if (!id) return;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    window.clearTimeout(pending.timeoutId);
    if (frame.type === "err") {
      pending.reject(new Error(String(frame.message ?? "PtyHost request failed")));
      return;
    }
    pending.resolve(frame);
  }

  private handleBinaryFrame(buffer: ArrayBuffer): void {
    if (buffer.byteLength < BINARY_HEADER_BYTES) throw new Error("Invalid PtyHost binary frame");
    const view = new DataView(buffer);
    if (view.getUint8(0) !== BINARY_PROTOCOL_VERSION) {
      throw new Error("Unsupported PtyHost binary protocol version");
    }
    const kindValue = view.getUint8(1);
    const sessionLength = view.getUint16(2, false);
    const sequence = Number(view.getBigUint64(4, false));
    const cols = view.getUint16(12, false);
    const rows = view.getUint16(14, false);
    const dataLength = view.getUint32(16, false);
    const expectedLength = BINARY_HEADER_BYTES + sessionLength + dataLength;
    if (expectedLength !== buffer.byteLength) throw new Error("Invalid PtyHost binary frame length");
    const bytes = new Uint8Array(buffer);
    const sessionId = new TextDecoder().decode(bytes.subarray(BINARY_HEADER_BYTES, BINARY_HEADER_BYTES + sessionLength));
    if (this.closedSessions.has(sessionId)) return;
    const data = bytes.slice(BINARY_HEADER_BYTES + sessionLength);
    const frame: TerminalBinaryFrame = {
      kind: kindValue === BINARY_KIND_REPLAY ? "replay" : "output",
      sessionId,
      sequence,
      cols,
      rows,
      data,
    };
    if (kindValue === BINARY_KIND_REPLAY) {
      const replay = this.replayFrames.get(sessionId);
      if (replay) replay.push(frame);
      return;
    }
    if (kindValue !== BINARY_KIND_OUTPUT) throw new Error("Unknown PtyHost binary frame kind");
    const previous = this.latestReceivedSequence.get(sessionId) ?? 0;
    if (sequence <= previous) return;
    this.latestReceivedSequence.set(sessionId, sequence);
    const listeners = this.outputListeners.get(sessionId);
    if (listeners?.size) listeners.forEach((listener) => listener(frame));
    else {
      const pending = this.pendingOutput.get(sessionId) ?? [];
      pending.push(frame);
      this.pendingOutput.set(sessionId, pending);
    }
  }

  private handleDisconnect(error: Error, socket?: WebSocket): void {
    if (socket && this.socket !== socket) return;
    this.stopHeartbeat();
    this.socket = null;
    this.pendingRequests.forEach(({ reject, timeoutId }) => {
      window.clearTimeout(timeoutId);
      reject(error);
    });
    this.pendingRequests.clear();
    if (this.attachedSessions.size > 0 && this.reconnectTimer === null) {
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        void this.reconnectAttachedSessions();
      }, 250);
    }
  }

  private async reconnectAttachedSessions(): Promise<void> {
    const reconnectSessions = [...this.attachedSessions].filter(
      (sessionId) => !this.closedSessions.has(sessionId),
    );
    if (reconnectSessions.length === 0) return;
    try {
      await this.connect();
      for (const sessionId of reconnectSessions) {
        if (this.closedSessions.has(sessionId)) continue;
        const previousSequence = this.latestCommittedSequence.get(sessionId) ?? 0;
        this.latestReceivedSequence.set(sessionId, previousSequence);
        const result = await this.attach(sessionId);
        if (result.attached) {
          this.queueReplay(
            sessionId,
            result.replay.filter((frame) => frame.sequence > previousSequence),
          );
        }
      }
    } catch {
      if (this.attachedSessions.size > 0 && this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          void this.reconnectAttachedSessions();
        }, 1_000);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = window.setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        socket.close();
        return;
      }
      this.send({ type: "ping", id: this.nextRequestId++ });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearSession(sessionId: string): void {
    this.attachedSessions.delete(sessionId);
    this.pendingOutput.delete(sessionId);
    this.pendingStatus.delete(sessionId);
    this.replayFrames.delete(sessionId);
    this.latestReceivedSequence.delete(sessionId);
    this.latestCommittedSequence.delete(sessionId);
    this.cancelReconnectWhenIdle();
  }

  private cancelReconnectWhenIdle(): void {
    if (this.attachedSessions.size > 0 || this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export const ptyHostSocket = new PtyHostSocket();
