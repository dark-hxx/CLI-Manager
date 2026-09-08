import { useTerminalStore } from "../state";
import { terminalProcessManager } from "./TerminalProcessManager";
import { ptyHostSocket } from "../transport/PtyHostSocket";
import { writeResourceDiagnostic } from "../../../shared/platform/resourceDiagnosticsLog";

const RUNTIME_DIAGNOSTIC_INTERVAL_MS = 30_000;

interface ChromiumPerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readJsHeap(): ChromiumPerformanceMemory | null {
  const memory = (performance as Performance & { memory?: ChromiumPerformanceMemory }).memory;
  if (!memory) return null;
  return {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  };
}

function collectWebviewSnapshot(): Record<string, unknown> {
  const state = useTerminalStore.getState();
  const sessionsByKind = state.sessions.reduce<Record<string, number>>((counts, session) => {
    const kind = session.kind ?? "pty";
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {});
  const subagentTranscriptChars = Object.values(state.subagentTranscripts).reduce(
    (total, transcript) => total + transcript.content.length,
    0,
  );
  return {
    sampledAt: Date.now(),
    window: {
      visibility: document.visibilityState,
      focused: document.hasFocus(),
    },
    browser: {
      jsHeap: readJsHeap(),
      domNodes: document.getElementsByTagName("*").length,
      canvases: document.getElementsByTagName("canvas").length,
      xtermElements: document.querySelectorAll(".xterm").length,
    },
    terminalStore: {
      sessions: state.sessions.length,
      sessionsByKind,
      statusListeners: Object.keys(state.statusListeners).length,
      hiddenBackgroundSessions: state.hiddenBackgroundSessionIds.size,
      daemonAttachPendingSessions: state.daemonAttachPendingSessionIds.size,
      subagentTranscripts: Object.keys(state.subagentTranscripts).length,
      subagentTranscriptChars,
    },
    processManager: terminalProcessManager.diagnosticsSnapshot(),
    ptyHost: ptyHostSocket.diagnosticsSnapshot(),
  };
}

function logRuntimeDiagnostics(): void {
  writeResourceDiagnostic("info", "webview", "runtimeSnapshot", collectWebviewSnapshot());
}

export function startRuntimeDiagnostics(): () => void {
  logRuntimeDiagnostics();
  const timer = window.setInterval(logRuntimeDiagnostics, RUNTIME_DIAGNOSTIC_INTERVAL_MS);
  return () => window.clearInterval(timer);
}
