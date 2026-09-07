import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ptyHostSocket,
  type TerminalBinaryFrame,
  type TerminalProcessTraits,
} from "../transport/PtyHostSocket";
import { writeResourceDiagnostic } from "../../lib/resourceDiagnosticsLog";

const OUTPUT_BACKLOG_WARN_BYTES = 4 * 1024 * 1024;
const OUTPUT_BACKLOG_WARN_FRAMES = 1024;
const OUTPUT_BACKLOG_RECOVERY_BYTES = OUTPUT_BACKLOG_WARN_BYTES / 2;
const OUTPUT_BACKLOG_RECOVERY_FRAMES = OUTPUT_BACKLOG_WARN_FRAMES / 2;
const DIAGNOSTIC_SESSION_LIMIT = 5;

export interface TerminalClaudeProviderLaunchConfig {
  appType: "claude";
  providerId: string;
  snapshotId: string;
  claudeSettingsPath: string;
}

export interface TerminalCodexProviderLaunchConfig {
  appType: "codex";
  providerId: string;
  snapshotId: string;
}

export interface TerminalGrokProviderLaunchConfig {
  appType: "grokbuild";
  providerId: string;
  snapshotId: string;
  grokModel: string;
}

export interface TerminalColors {
  foreground: string;
  background: string;
}

export interface TerminalCreateRequest extends Record<string, unknown> {
  cwd: string | null;
  envVars: Record<string, string> | null;
  shell: string | null;
  hookEnvEnabled: boolean;
  claudeProvider: TerminalClaudeProviderLaunchConfig | null;
  codexProvider: TerminalCodexProviderLaunchConfig | null;
  grokProvider: TerminalGrokProviderLaunchConfig | null;
  sshLaunch: unknown | null;
  terminalColors: TerminalColors;
}

interface PreparedTerminalCreate {
  sessionId: string;
  cwd: string | null;
  envVars: Record<string, string>;
  shell: string | null;
  sshLaunch: unknown | null;
  daemonRestarted: boolean;
}

export interface TerminalStatusEvent {
  status: string;
  exit_code: number | null;
}

export interface TerminalAttachResult {
  attached: boolean;
  alive: boolean;
  cwd?: string | null;
  shell?: string | null;
  createdAtMs?: number;
  taskStatus?: string | null;
  taskUpdatedAtMs?: number | null;
  replay: TerminalBinaryFrame[];
  processTraits?: TerminalProcessTraits | null;
  replayTruncated?: boolean;
}

export interface TerminalOutputDelivery {
  frame: TerminalBinaryFrame;
  commit: (charCount: number) => void;
}

interface QueuedOutputFrame {
  frame: TerminalBinaryFrame;
  committed: boolean;
  charCount: number;
}

interface TerminalOutputState {
  frames: QueuedOutputFrame[];
  sequences: Set<number>;
  consumer: ((delivery: TerminalOutputDelivery) => void) | null;
  consumerGeneration: number;
  deliveredCount: number;
  socketUnlisten: UnlistenFn | null;
  latestCommittedSequence: number;
  queuedBytes: number;
  backlogWarned: boolean;
}

export interface TerminalProcessDiagnosticsSnapshot {
  trackedSessions: number;
  sessionsWithConsumers: number;
  queuedFrames: number;
  queuedBytes: number;
  committedFrames: number;
  topBacklogs: Array<{
    sessionId: string;
    consumerAttached: boolean;
    queuedFrames: number;
    queuedBytes: number;
    committedFrames: number;
    deliveredFrames: number;
  }>;
}

/**
 * Owns the frontend side of the PTY process contract.
 *
 * Low-frequency launch preparation uses Tauri IPC; PTY create/write/resize/
 * close/output use the direct PtyHost WebSocket. Keeping all callers behind
 * this boundary prevents transport and lifecycle logic from leaking back into
 * components and stores.
 */
export class TerminalProcessManager {
  private readonly outputStates = new Map<string, TerminalOutputState>();
  private readonly processTraits = new Map<string, TerminalProcessTraits>();

  create(request: TerminalCreateRequest): Promise<string> {
    return invoke<PreparedTerminalCreate>("pty_prepare_create", request).then(async (prepared) => {
      const sessionId = prepared.sessionId;
      try {
        if (prepared.daemonRestarted) {
          ptyHostSocket.resetAfterDaemonRestart();
        }
        const traits = await ptyHostSocket.create(
          sessionId,
          prepared.cwd,
          prepared.envVars,
          prepared.shell,
          prepared.sshLaunch,
          request.terminalColors,
        );
        if (traits) this.processTraits.set(sessionId, traits);
      } catch (error) {
        throw error;
      }
      return sessionId;
    });
  }

  write(sessionId: string, data: string): Promise<void> {
    return ptyHostSocket.write(sessionId, data);
  }

  writeBinary(sessionId: string, data: string): Promise<void> {
    return ptyHostSocket.writeBinary(sessionId, data);
  }

  setTerminalColors(sessionId: string, colors: TerminalColors): Promise<void> {
    return ptyHostSocket.setTerminalColors(sessionId, colors);
  }

  resize(
    sessionId: string,
    cols: number,
    rows: number,
    pixelWidth?: number,
    pixelHeight?: number,
  ): Promise<void> {
    return ptyHostSocket.resize(sessionId, cols, rows, pixelWidth, pixelHeight);
  }

  checkpoint(
    sessionId: string,
    cols: number,
    rows: number,
    serializedState: string,
  ): Promise<void> {
    const sequence = this.outputStates.get(sessionId)?.latestCommittedSequence
      ?? ptyHostSocket.getLatestCommittedSequence(sessionId);
    return ptyHostSocket.checkpoint(sessionId, sequence, cols, rows, serializedState);
  }

  close(sessionId: string): Promise<void> {
    return ptyHostSocket.close(sessionId).finally(() => {
      this.clearOutputState(sessionId);
      this.processTraits.delete(sessionId);
    });
  }

  closeAll(): Promise<void> {
    return ptyHostSocket.closeAll().finally(() => {
      [...this.outputStates.keys()].forEach((sessionId) => this.clearOutputState(sessionId));
      this.processTraits.clear();
    });
  }

  attach(sessionId: string): Promise<TerminalAttachResult> {
    return ptyHostSocket.attach(sessionId).then((result) => {
      if (result.processTraits) this.processTraits.set(sessionId, result.processTraits);
      return result;
    });
  }

  getProcessTraits(sessionId: string): TerminalProcessTraits | null {
    return this.processTraits.get(sessionId) ?? null;
  }

  diagnosticsSnapshot(): TerminalProcessDiagnosticsSnapshot {
    const sessions = [...this.outputStates.entries()].map(([sessionId, state]) => ({
      sessionId,
      consumerAttached: state.consumer !== null,
      queuedFrames: state.frames.length,
      queuedBytes: state.queuedBytes,
      committedFrames: state.frames.reduce(
        (count, frame) => count + (frame.committed ? 1 : 0),
        0,
      ),
      deliveredFrames: state.deliveredCount,
    }));
    return {
      trackedSessions: sessions.length,
      sessionsWithConsumers: sessions.reduce(
        (count, session) => count + (session.consumerAttached ? 1 : 0),
        0,
      ),
      queuedFrames: sessions.reduce((total, session) => total + session.queuedFrames, 0),
      queuedBytes: sessions.reduce((total, session) => total + session.queuedBytes, 0),
      committedFrames: sessions.reduce((total, session) => total + session.committedFrames, 0),
      topBacklogs: sessions
        .sort((left, right) => right.queuedBytes - left.queuedBytes || right.queuedFrames - left.queuedFrames)
        .slice(0, DIAGNOSTIC_SESSION_LIMIT),
    };
  }

  async subscribeOutput(sessionId: string, listener: (delivery: TerminalOutputDelivery) => void): Promise<UnlistenFn> {
    await ptyHostSocket.connect();
    const state = this.getOutputState(sessionId);
    if (!state.socketUnlisten) {
      state.socketUnlisten = ptyHostSocket.subscribeOutput(sessionId, (frame) => {
        this.enqueueOutputFrame(sessionId, frame);
      });
    }
    state.consumerGeneration += 1;
    const generation = state.consumerGeneration;
    state.consumer = listener;
    state.deliveredCount = 0;
    this.deliverPendingOutput(sessionId, state);
    return () => {
      const current = this.outputStates.get(sessionId);
      if (!current || current.consumerGeneration !== generation) return;
      current.consumer = null;
      current.consumerGeneration += 1;
      current.deliveredCount = 0;
    };
  }

  async subscribeStatus(sessionId: string, listener: (payload: TerminalStatusEvent) => void): Promise<UnlistenFn> {
    await ptyHostSocket.connect();
    return ptyHostSocket.subscribeStatus(sessionId, listener);
  }

  acknowledgeOutput(sessionId: string, sequence: number, charCount: number): void {
    ptyHostSocket.acknowledge(sessionId, sequence, charCount);
  }

  private getOutputState(sessionId: string): TerminalOutputState {
    let state = this.outputStates.get(sessionId);
    if (!state) {
      state = {
        frames: [],
        sequences: new Set(),
        consumer: null,
        consumerGeneration: 0,
        deliveredCount: 0,
        socketUnlisten: null,
        latestCommittedSequence: 0,
        queuedBytes: 0,
        backlogWarned: false,
      };
      this.outputStates.set(sessionId, state);
    }
    return state;
  }

  private enqueueOutputFrame(sessionId: string, frame: TerminalBinaryFrame): void {
    const state = this.getOutputState(sessionId);
    if (frame.kind === "reset") {
      state.frames = [];
      state.sequences.clear();
      state.deliveredCount = 0;
      state.latestCommittedSequence = 0;
      state.queuedBytes = 0;
      state.frames.push({ frame, committed: false, charCount: 0 });
      state.queuedBytes += frame.data.byteLength;
      this.updateBacklogWarning(sessionId, state);
      this.deliverPendingOutput(sessionId, state);
      return;
    }
    if (frame.replayBatchEnd) {
      state.frames.push({ frame, committed: false, charCount: 0 });
      state.queuedBytes += frame.data.byteLength;
      this.updateBacklogWarning(sessionId, state);
      this.deliverPendingOutput(sessionId, state);
      return;
    }
    if (frame.sequence <= state.latestCommittedSequence || state.sequences.has(frame.sequence)) return;
    state.sequences.add(frame.sequence);
    state.frames.push({ frame, committed: false, charCount: 0 });
    state.queuedBytes += frame.data.byteLength;
    this.updateBacklogWarning(sessionId, state);
    this.deliverPendingOutput(sessionId, state);
  }

  private deliverPendingOutput(sessionId: string, state: TerminalOutputState): void {
    const consumer = state.consumer;
    if (!consumer) return;
    const generation = state.consumerGeneration;
    while (state.deliveredCount < state.frames.length) {
      const queued = state.frames[state.deliveredCount];
      state.deliveredCount += 1;
      consumer({
        frame: queued.frame,
        commit: (charCount) => {
          const current = this.outputStates.get(sessionId);
          if (!current || current.consumerGeneration !== generation || queued.committed) return;
          queued.committed = true;
          queued.charCount = Math.max(0, charCount);
          this.drainCommittedOutput(sessionId, current);
        },
      });
    }
  }

  private drainCommittedOutput(sessionId: string, state: TerminalOutputState): void {
    while (state.frames[0]?.committed) {
      const [queued] = state.frames.splice(0, 1);
      state.sequences.delete(queued.frame.sequence);
      state.queuedBytes = Math.max(0, state.queuedBytes - queued.frame.data.byteLength);
      state.deliveredCount = Math.max(0, state.deliveredCount - 1);
      state.latestCommittedSequence = Math.max(
        state.latestCommittedSequence,
        queued.frame.kind === "reset" ? 0 : queued.frame.sequence,
      );
      if (queued.frame.kind !== "reset" && !queued.frame.replayBatchEnd) {
        ptyHostSocket.acknowledge(sessionId, queued.frame.sequence, queued.charCount);
      }
    }
    this.updateBacklogWarning(sessionId, state);
  }

  private updateBacklogWarning(sessionId: string, state: TerminalOutputState): void {
    const thresholdExceeded =
      state.queuedBytes >= OUTPUT_BACKLOG_WARN_BYTES
      || state.frames.length >= OUTPUT_BACKLOG_WARN_FRAMES;
    if (thresholdExceeded && !state.backlogWarned) {
      state.backlogWarned = true;
      writeResourceDiagnostic("warn", "terminalProcessManager", "backlogThresholdExceeded", {
        area: "terminalProcessManager",
        sessionId,
        queuedFrames: state.frames.length,
        queuedBytes: state.queuedBytes,
        consumerAttached: state.consumer !== null,
        deliveredFrames: state.deliveredCount,
      });
      return;
    }
    const recovered =
      state.queuedBytes < OUTPUT_BACKLOG_RECOVERY_BYTES
      && state.frames.length < OUTPUT_BACKLOG_RECOVERY_FRAMES;
    if (state.backlogWarned && recovered) {
      state.backlogWarned = false;
      writeResourceDiagnostic("info", "terminalProcessManager", "backlogRecovered", {
        area: "terminalProcessManager",
        sessionId,
        queuedFrames: state.frames.length,
        queuedBytes: state.queuedBytes,
        consumerAttached: state.consumer !== null,
      });
    }
  }

  private clearOutputState(sessionId: string): void {
    const state = this.outputStates.get(sessionId);
    state?.socketUnlisten?.();
    this.outputStates.delete(sessionId);
  }
}

export const terminalProcessManager = new TerminalProcessManager();
