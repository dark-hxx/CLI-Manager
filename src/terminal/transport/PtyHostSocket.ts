import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logInfo, logWarn } from "../../lib/logger";

const BINARY_PROTOCOL_VERSION = 1;
const BINARY_KIND_OUTPUT = 1;
const BINARY_KIND_REPLAY = 2;
const BINARY_KIND_INPUT = 3;
const BINARY_KIND_CHECKPOINT = 4;
const BINARY_KIND_REPLAY_RESET = 5;
const BINARY_HEADER_BYTES = 20;
const MAX_BINARY_FRAME_BYTES = 8 * 1024 * 1024;
const CONTROL_PROTOCOL_VERSION = 2;
const FEATURE_WS_BINARY_OUTPUT = "ws_binary_output_v1";
const FEATURE_WS_BINARY_INPUT = "ws_binary_input_v1";
const FEATURE_CHECKPOINT_REPLAY = "checkpoint_replay_v1";
const FEATURE_TERMINAL_COLORS = "terminal_colors_v1";
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface PtyHostEndpoint {
  transportMode: "websocket" | "legacy";
  url: string | null;
  token: string | null;
  protocolVersion: number;
  binaryProtocolVersion: number;
  features: string[];
  daemonVersion: string;
}

interface PendingRequest {
  resolve: (frame: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

interface SocketDisconnectDetails {
  cause: "connect-error" | "auth-timeout" | "auth-failed" | "error" | "close" | "heartbeat-timeout" | "parse-error";
  authenticated: boolean;
  code?: number | null;
  reason?: string | null;
  wasClean?: boolean | null;
}

export interface TerminalBinaryFrame {
  kind: "output" | "replay" | "reset";
  sessionId: string;
  sequence: number;
  cols: number;
  rows: number;
  data: Uint8Array;
  replayBatchEnd?: boolean;
}

export interface TerminalProcessTraits {
  os: "windows" | "macos" | "linux" | string;
  windowsPty?: {
    backend: "conpty" | "winpty";
    buildNumber?: number | null;
    usesConptyDll?: boolean;
  } | null;
}

export interface TerminalColors {
  foreground: string;
  background: string;
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
  processTraits?: TerminalProcessTraits | null;
  replayTruncated?: boolean;
}

export interface PtyHostStatusEvent {
  status: string;
  exit_code: number | null;
}

type OutputListener = (frame: TerminalBinaryFrame) => void;
type StatusListener = (event: PtyHostStatusEvent) => void;

function checkpointKey(sessionId: string, sequence: number): string {
  return `${sessionId}:${sequence}`;
}

function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeProcessTraits(value: unknown): TerminalProcessTraits | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.os !== "string") return null;
  const windowsPtyRaw = raw.windowsPty;
  let windowsPty: TerminalProcessTraits["windowsPty"] = null;
  if (windowsPtyRaw && typeof windowsPtyRaw === "object") {
    const candidate = windowsPtyRaw as Record<string, unknown>;
    if (candidate.backend === "conpty" || candidate.backend === "winpty") {
      windowsPty = {
        backend: candidate.backend,
        buildNumber: typeof candidate.buildNumber === "number" ? candidate.buildNumber : null,
        usesConptyDll: candidate.usesConptyDll === true,
      };
    }
  }
  return { os: raw.os, windowsPty };
}

export class PtyHostSocket {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly outputListeners = new Map<string, Set<OutputListener>>();
  private readonly statusListeners = new Map<string, Set<StatusListener>>();
  private readonly pendingOutput = new Map<string, TerminalBinaryFrame[]>();
  private readonly pendingStatus = new Map<string, PtyHostStatusEvent>();
  private readonly pendingCheckpoints = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>();
  private readonly latestReceivedSequence = new Map<string, number>();
  private readonly latestCommittedSequence = new Map<string, number>();
  private readonly attachedSessions = new Set<string>();
  private readonly closedSessions = new Set<string>();
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private lastPongAt = 0;
  private connectedFeatures = new Set<string>();
  private transportMode: "websocket" | "legacy" | null = null;
  private legacyOutputUnlisten: UnlistenFn | null = null;
  private legacyStatusUnlisten: UnlistenFn | null = null;

  async connect(): Promise<void> {
    if (this.transportMode === "legacy") return;
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

  async writeBinary(sessionId: string, data: string): Promise<void> {
    await this.connect();
    if (!this.connectedFeatures.has(FEATURE_WS_BINARY_INPUT)) {
      throw new Error("PtyHost binary input is unavailable");
    }
    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      bytes[index] = data.charCodeAt(index) & 0xff;
    }
    this.sendBinary(BINARY_KIND_INPUT, sessionId, 0, 0, 0, bytes);
  }

  async create(
    sessionId: string,
    cwd: string | null,
    envVars: Record<string, string>,
    shell: string | null,
    sshLaunch: unknown | null,
    terminalColors: TerminalColors,
  ): Promise<TerminalProcessTraits | null> {
    this.closedSessions.delete(sessionId);
    this.attachedSessions.add(sessionId);
    this.latestReceivedSequence.set(sessionId, 0);
    this.latestCommittedSequence.set(sessionId, 0);
    try {
      await this.connect();
      if (this.transportMode === "legacy") {
        const upgraded = await invoke<boolean>("pty_daemon_upgrade_if_idle");
        if (!upgraded) throw new Error("PTY_HOST_LEGACY_CREATE_BLOCKED");
        this.transportMode = null;
        this.connectedFeatures.clear();
        await this.connect();
        if (this.transportMode === "legacy") {
          throw new Error("PTY_HOST_LEGACY_CREATE_BLOCKED");
        }
      }
      const frame = await this.request({
        type: "create",
        session_id: sessionId,
        cwd,
        env_vars: envVars,
        shell,
        ssh_launch: sshLaunch,
        terminal_colors: terminalColors,
      });
      const meta = (frame.meta ?? {}) as Record<string, unknown>;
      return normalizeProcessTraits(meta.processTraits);
    } catch (error) {
      try {
        await this.connect();
        const recovered = await this.attach(sessionId);
        if (recovered.attached) {
          return recovered.processTraits ?? null;
        }
      } catch {
        // Preserve the original create error after the recovery probe fails.
      }
      this.clearSession(sessionId);
      throw error;
    }
  }

  async setTerminalColors(sessionId: string, terminalColors: TerminalColors): Promise<void> {
    await this.connect();
    if (!this.connectedFeatures.has(FEATURE_TERMINAL_COLORS)) return;
    await this.request({
      type: "set_terminal_colors",
      session_id: sessionId,
      terminal_colors: terminalColors,
    });
  }

  async resize(
    sessionId: string,
    cols: number,
    rows: number,
    pixelWidth?: number,
    pixelHeight?: number,
  ): Promise<void> {
    await this.request({
      type: "resize",
      session_id: sessionId,
      cols,
      rows,
      pixel_width: pixelWidth,
      pixel_height: pixelHeight,
    });
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
    this.pendingCheckpoints.forEach(({ reject, timeoutId }) => {
      window.clearTimeout(timeoutId);
      reject(new Error("PtyHost sessions closed"));
    });
    this.pendingCheckpoints.clear();
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
    this.attachedSessions.add(sessionId);
    try {
      const afterSequence = this.latestCommittedSequence.get(sessionId) ?? 0;
      const frame = await this.request({
        type: "attach",
        session_id: sessionId,
        after_sequence: afterSequence > 0 ? afterSequence : undefined,
      });
      const meta = (frame.meta ?? {}) as Record<string, unknown>;
      if (this.transportMode === "legacy") this.deliverLegacyReplay(sessionId, frame);
      const latestSequence = Number(frame.latest_sequence ?? 0);
      this.latestReceivedSequence.set(sessionId, latestSequence);
      return {
        attached: true,
        alive: meta.alive === true,
        replay: [],
        cwd: typeof meta.cwd === "string" ? meta.cwd : null,
        shell: typeof meta.shell === "string" ? meta.shell : null,
        createdAtMs: Number(meta.createdAtMs ?? 0),
        taskStatus: typeof meta.taskStatus === "string" ? meta.taskStatus : null,
        taskUpdatedAtMs: meta.taskUpdatedAtMs == null ? null : Number(meta.taskUpdatedAtMs),
        processTraits: normalizeProcessTraits(meta.processTraits),
        replayTruncated: frame.replay_truncated === true || meta.replayTruncated === true,
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

  getLatestCommittedSequence(sessionId: string): number {
    return this.latestCommittedSequence.get(sessionId) ?? 0;
  }

  async checkpoint(
    sessionId: string,
    sequence: number,
    cols: number,
    rows: number,
    serializedState: string,
  ): Promise<void> {
    await this.connect();
    if (!this.connectedFeatures.has(FEATURE_CHECKPOINT_REPLAY)) return;
    const key = checkpointKey(sessionId, sequence);
    const existing = this.pendingCheckpoints.get(key);
    if (existing) {
      return new Promise<void>((resolve, reject) => {
        const poll = window.setInterval(() => {
          if (this.pendingCheckpoints.has(key)) return;
          window.clearInterval(poll);
          resolve();
        }, 10);
        window.setTimeout(() => {
          window.clearInterval(poll);
          reject(new Error("PtyHost checkpoint timed out"));
        }, REQUEST_TIMEOUT_MS);
      });
    }
    const payload = new TextEncoder().encode(serializedState);
    const sessionBytes = new TextEncoder().encode(sessionId);
    if (BINARY_HEADER_BYTES + sessionBytes.length + payload.length > MAX_BINARY_FRAME_BYTES) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pendingCheckpoints.delete(key);
        reject(new Error("PtyHost checkpoint timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pendingCheckpoints.set(key, { resolve, reject, timeoutId });
      try {
        this.sendBinary(BINARY_KIND_CHECKPOINT, sessionId, sequence, cols, rows, payload);
      } catch (error) {
        window.clearTimeout(timeoutId);
        this.pendingCheckpoints.delete(key);
        reject(error);
      }
    });
  }

  private async openSocket(): Promise<void> {
    const endpoint = await invoke<PtyHostEndpoint | null>("pty_host_get_endpoint");
    if (endpoint?.transportMode === "legacy") {
      this.transportMode = "legacy";
      this.connectedFeatures = new Set(endpoint.features);
      this.nextRequestId = Math.max(this.nextRequestId, Date.now());
      await this.ensureLegacyListeners();
      logInfo("PtyHost legacy transport active", this.lifecycleSnapshot({
        features: [...this.connectedFeatures],
      }));
      return;
    }
    if (
      !endpoint
      || endpoint.transportMode !== "websocket"
      || !endpoint.url
      || !endpoint.token
      || endpoint.protocolVersion < CONTROL_PROTOCOL_VERSION
      || endpoint.binaryProtocolVersion !== BINARY_PROTOCOL_VERSION
      || !endpoint.features.includes(FEATURE_WS_BINARY_OUTPUT)
    ) {
      logWarn("PtyHost WebSocket endpoint unavailable", {
        endpointPresent: endpoint !== null,
        transportMode: endpoint?.transportMode ?? null,
        protocolVersion: endpoint?.protocolVersion ?? null,
        binaryProtocolVersion: endpoint?.binaryProtocolVersion ?? null,
        hasUrl: Boolean(endpoint?.url),
        hasToken: Boolean(endpoint?.token),
        features: endpoint?.features ?? [],
      });
      throw new Error("PtyHost WebSocket endpoint unavailable");
    }
    this.connectedFeatures = new Set(endpoint.features);
    this.transportMode = "websocket";
    const endpointUrl = endpoint.url;
    const endpointToken = endpoint.token;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpointUrl);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      let authenticated = false;
      let authSettled = false;
      const authTimeoutId = window.setTimeout(() => {
        if (authSettled) return;
        authSettled = true;
        const error = new Error("PtyHost authentication timed out");
        if (!authenticated) reject(error);
        this.handleDisconnect(error, socket, {
          cause: "auth-timeout",
          authenticated,
        });
        socket.close();
      }, AUTH_TIMEOUT_MS);
      const rejectAuth = (error: Error) => {
        if (authSettled) return;
        authSettled = true;
        window.clearTimeout(authTimeoutId);
        reject(error);
      };
      const fail = (error: Error, details: SocketDisconnectDetails) => {
        if (!authenticated) rejectAuth(error);
        this.handleDisconnect(error, socket, details);
      };
      socket.onopen = () => {
        this.send({
          type: "auth",
          token: endpointToken,
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
              logInfo("PtyHost websocket connected", this.lifecycleSnapshot({
                features: [...this.connectedFeatures],
              }));
              resolve();
              return;
            }
            if (frame.type === "auth_err") {
              fail(new Error(String(frame.reason ?? "PtyHost authentication failed")), {
                cause: "auth-failed",
                authenticated,
              });
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
          fail(error instanceof Error ? error : new Error(String(error)), {
            cause: "parse-error",
            authenticated,
          });
          socket.close();
        }
      };
      socket.onerror = () => fail(new Error("PtyHost WebSocket connection failed"), {
        cause: "connect-error",
        authenticated,
      });
      socket.onclose = (event) => fail(this.createDisconnectError(event), {
        cause: "close",
        authenticated,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    });
  }

  private async request(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    const id = this.nextRequestId++;
    if (this.transportMode === "legacy") {
      return invoke<Record<string, unknown>>("pty_legacy_request", {
        frame: { ...frame, id },
      });
    }
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

  private sendBinary(
    kind: number,
    sessionId: string,
    sequence: number,
    cols: number,
    rows: number,
    data: Uint8Array,
  ): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("PtyHost WebSocket is not connected");
    }
    const sessionBytes = new TextEncoder().encode(sessionId);
    if (sessionBytes.length > 0xffff) throw new Error("PtyHost session id is too long");
    const frame = new ArrayBuffer(BINARY_HEADER_BYTES + sessionBytes.length + data.length);
    const view = new DataView(frame);
    view.setUint8(0, BINARY_PROTOCOL_VERSION);
    view.setUint8(1, kind);
    view.setUint16(2, sessionBytes.length, false);
    view.setBigUint64(4, BigInt(sequence), false);
    view.setUint16(12, cols, false);
    view.setUint16(14, rows, false);
    view.setUint32(16, data.length, false);
    const bytes = new Uint8Array(frame);
    bytes.set(sessionBytes, BINARY_HEADER_BYTES);
    bytes.set(data, BINARY_HEADER_BYTES + sessionBytes.length);
    this.socket.send(frame);
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
    if (frame.type === "checkpoint_accepted" || frame.type === "checkpoint_rejected") {
      const sessionId = String(frame.session_id ?? "");
      const sequence = Number(frame.sequence ?? 0);
      const pending = this.pendingCheckpoints.get(checkpointKey(sessionId, sequence));
      if (!pending) return;
      this.pendingCheckpoints.delete(checkpointKey(sessionId, sequence));
      window.clearTimeout(pending.timeoutId);
      if (frame.type === "checkpoint_accepted") pending.resolve();
      else pending.reject(new Error(String(frame.message ?? "PtyHost checkpoint rejected")));
      return;
    }
    if (frame.type === "attached") {
      const sessionId = String(frame.session_id ?? "");
      if (sessionId) {
        this.emitOutputFrame({
          kind: "replay",
          sessionId,
          sequence: 0,
          cols: 0,
          rows: 0,
          data: new Uint8Array(),
          replayBatchEnd: true,
        });
      }
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
      kind: kindValue === BINARY_KIND_REPLAY_RESET
        ? "reset"
        : kindValue === BINARY_KIND_REPLAY
          ? "replay"
          : "output",
      sessionId,
      sequence,
      cols,
      rows,
      data,
    };
    if (kindValue === BINARY_KIND_REPLAY_RESET) {
      this.emitOutputFrame(frame);
      return;
    }
    if (kindValue === BINARY_KIND_REPLAY) {
      this.emitOutputFrame(frame);
      return;
    }
    if (kindValue !== BINARY_KIND_OUTPUT) throw new Error("Unknown PtyHost binary frame kind");
    const previous = this.latestReceivedSequence.get(sessionId) ?? 0;
    if (sequence <= previous) return;
    this.latestReceivedSequence.set(sessionId, sequence);
    this.emitOutputFrame(frame);
  }

  private emitOutputFrame(frame: TerminalBinaryFrame): void {
    const listeners = this.outputListeners.get(frame.sessionId);
    if (listeners?.size) listeners.forEach((listener) => listener(frame));
    else {
      const pending = this.pendingOutput.get(frame.sessionId) ?? [];
      pending.push(frame);
      this.pendingOutput.set(frame.sessionId, pending);
    }
  }

  private async ensureLegacyListeners(): Promise<void> {
    if (!this.legacyOutputUnlisten) {
      this.legacyOutputUnlisten = await listen<Record<string, unknown>>(
        "pty-legacy-output",
        ({ payload }) => {
          const sessionId = String(payload.sessionId ?? "");
          if (!sessionId || this.closedSessions.has(sessionId)) return;
          const sequence = Number(payload.sequence ?? 0);
          const previous = this.latestReceivedSequence.get(sessionId) ?? 0;
          if (sequence <= previous) return;
          this.latestReceivedSequence.set(sessionId, sequence);
          this.emitOutputFrame({
            kind: "output",
            sessionId,
            sequence,
            cols: Number(payload.cols ?? 80),
            rows: Number(payload.rows ?? 24),
            data: decodeBase64(String(payload.dataBase64 ?? "")),
          });
        },
      );
    }
    if (!this.legacyStatusUnlisten) {
      this.legacyStatusUnlisten = await listen<Record<string, unknown>>(
        "pty-legacy-status",
        ({ payload }) => {
          const sessionId = String(payload.sessionId ?? "");
          if (!sessionId || this.closedSessions.has(sessionId)) return;
          const event: PtyHostStatusEvent = {
            status: String(payload.status ?? "exited"),
            exit_code: payload.exit_code == null ? null : Number(payload.exit_code),
          };
          const listeners = this.statusListeners.get(sessionId);
          if (listeners?.size) listeners.forEach((listener) => listener(event));
          else this.pendingStatus.set(sessionId, event);
        },
      );
    }
  }

  private deliverLegacyReplay(sessionId: string, frame: Record<string, unknown>): void {
    if (frame.replay_reset === true) {
      this.emitOutputFrame({
        kind: "reset",
        sessionId,
        sequence: 0,
        cols: 0,
        rows: 0,
        data: new Uint8Array(),
      });
    }
    const replay = Array.isArray(frame.replay) ? frame.replay : [];
    replay.forEach((value) => {
      if (!value || typeof value !== "object") return;
      const entry = value as Record<string, unknown>;
      this.emitOutputFrame({
        kind: "replay",
        sessionId,
        sequence: Number(entry.sequence ?? 0),
        cols: Number(entry.cols ?? 80),
        rows: Number(entry.rows ?? 24),
        data: decodeBase64(String(entry.dataBase64 ?? entry.data_base64 ?? "")),
      });
    });
    this.emitOutputFrame({
      kind: "replay",
      sessionId,
      sequence: 0,
      cols: 0,
      rows: 0,
      data: new Uint8Array(),
      replayBatchEnd: true,
    });
  }

  private handleDisconnect(error: Error, socket?: WebSocket, details?: SocketDisconnectDetails): void {
    if (socket && this.socket !== socket) return;
    this.stopHeartbeat();
    this.socket = null;
    const connectedFeatures = [...this.connectedFeatures];
    this.connectedFeatures.clear();
    logWarn(
      details?.cause === "heartbeat-timeout" ? "PtyHost heartbeat timed out" : "PtyHost websocket disconnected",
      {
        ...this.lifecycleSnapshot({
          authenticated: details?.authenticated ?? false,
          closeCause: details?.cause ?? "unknown",
          closeCode: details?.code ?? null,
          closeReason: details?.reason ?? null,
          wasClean: details?.wasClean ?? null,
          error: error.message,
          features: connectedFeatures,
        }),
      },
    );
    this.pendingRequests.forEach(({ reject, timeoutId }) => {
      window.clearTimeout(timeoutId);
      reject(error);
    });
    this.pendingRequests.clear();
    this.pendingCheckpoints.forEach(({ reject, timeoutId }) => {
      window.clearTimeout(timeoutId);
      reject(error);
    });
    this.pendingCheckpoints.clear();
    if (this.attachedSessions.size > 0 && this.reconnectTimer === null) {
      logInfo("PtyHost reconnect scheduled", this.lifecycleSnapshot({
        cause: details?.cause ?? "unknown",
        delayMs: 250,
      }));
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
    logInfo("PtyHost reconnect attempt started", this.lifecycleSnapshot({
      reconnectSessions: reconnectSessions.length,
    }));
    try {
      await this.connect();
      logInfo("PtyHost reconnect transport ready", this.lifecycleSnapshot({
        reconnectSessions: reconnectSessions.length,
      }));
      for (const sessionId of reconnectSessions) {
        if (this.closedSessions.has(sessionId)) continue;
        const previousSequence = this.latestCommittedSequence.get(sessionId) ?? 0;
        this.latestReceivedSequence.set(sessionId, previousSequence);
        await this.attach(sessionId);
      }
      logInfo("PtyHost reconnect attempt completed", this.lifecycleSnapshot({
        reconnectSessions: reconnectSessions.length,
      }));
    } catch (error) {
      logWarn("PtyHost reconnect attempt failed", this.lifecycleSnapshot({
        reconnectSessions: reconnectSessions.length,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (this.attachedSessions.size > 0 && this.reconnectTimer === null) {
        logInfo("PtyHost reconnect retry scheduled", this.lifecycleSnapshot({
          reconnectSessions: reconnectSessions.length,
          delayMs: 1000,
        }));
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
        const error = new Error(`PtyHost heartbeat timed out after ${HEARTBEAT_TIMEOUT_MS}ms`);
        this.handleDisconnect(error, socket, {
          cause: "heartbeat-timeout",
          authenticated: true,
        });
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
    [...this.pendingCheckpoints.entries()]
      .filter(([key]) => key.startsWith(`${sessionId}:`))
      .forEach(([key, pending]) => {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("PtyHost session closed"));
        this.pendingCheckpoints.delete(key);
      });
    this.latestReceivedSequence.delete(sessionId);
    this.latestCommittedSequence.delete(sessionId);
    this.cancelReconnectWhenIdle();
  }

  private lifecycleSnapshot(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      transportMode: this.transportMode,
      attachedSessions: this.attachedSessions.size,
      pendingRequests: this.pendingRequests.size,
      pendingCheckpoints: this.pendingCheckpoints.size,
      reconnectTimerActive: this.reconnectTimer !== null,
      ...extra,
    };
  }

  private createDisconnectError(event: CloseEvent): Error {
    const details = [
      `code=${event.code}`,
      `wasClean=${event.wasClean}`,
      event.reason ? `reason=${event.reason}` : null,
    ]
      .filter((item): item is string => item !== null)
      .join(", ");
    return new Error(details ? `PtyHost WebSocket disconnected (${details})` : "PtyHost WebSocket disconnected");
  }

  private cancelReconnectWhenIdle(): void {
    if (this.attachedSessions.size > 0 || this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

export const ptyHostSocket = new PtyHostSocket();
