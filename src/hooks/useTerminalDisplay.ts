import { useRef, type RefObject } from "react";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { refreshTerminalViewport } from "../lib/terminalVisibility";
import { isLightTerminalTheme } from "../lib/terminalThemes";
import { debugConsoleWarn } from "../lib/debugConsole";
import { logError, logInfo, logWarn } from "../lib/logger";
import { markTerminalSnapshotDirty } from "../lib/sessionSnapshotPersistence";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  useSettingsStore,
} from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";

const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 8;
const HIDDEN_WEBGL_DISPOSE_DELAY_MS = 10_000;
const ACTIVE_WRITE_FRAME_BUDGET = 64 * 1024;
const ACTIVE_WRITE_QUEUE_MAX_CHARS = 16 * 1024 * 1024;
const ACTIVE_WRITE_QUEUE_LOG_INTERVAL_MS = 2000;
const INACTIVE_BUFFER_MIN_CHARS = 256 * 1024;
const INACTIVE_BUFFER_MAX_CHARS = 8 * 1024 * 1024;
const INACTIVE_BUFFER_CHARS_PER_SCROLLBACK_ROW = 256;

type NormalizeTerminalOutput = (text: string) => string;
type TransformTerminalOutput = (text: string) => string;
type AfterTerminalWrite = (terminal: Terminal) => void;

interface ActiveWriteQueueItem {
  text: string;
  inactiveReplay: boolean;
}

const getInactiveBufferLimit = (scrollbackRows: number) => Math.min(
  INACTIVE_BUFFER_MAX_CHARS,
  Math.max(INACTIVE_BUFFER_MIN_CHARS, scrollbackRows * INACTIVE_BUFFER_CHARS_PER_SCROLLBACK_ROW)
);

interface UseTerminalDisplayOptions {
  sessionId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  isVisibleRef: RefObject<boolean>;
  isComposingRef: RefObject<boolean>;
  lowMemoryMode: boolean;
  terminalScrollbackRows: number;
  disableHardwareAcceleration: boolean;
  linuxGraphicsDisableWebgl: boolean;
  isTransparentRef: RefObject<boolean>;
  normalizeOutputRef: RefObject<NormalizeTerminalOutput>;
  transformOutputRef: RefObject<TransformTerminalOutput>;
  afterTerminalWriteRef: RefObject<AfterTerminalWrite | null>;
  onInactiveReplayPendingChange: (pending: boolean) => void;
  onPtyOutputListenError: (err: unknown) => void;
  onViewportRefreshNeeded?: () => void;
}

export interface UseTerminalDisplayResult {
  syncWebglRenderer: (terminal: Terminal, theme: ITheme) => boolean;
  scheduleHiddenWebglDispose: (enabled: boolean) => void;
  clearHiddenWebglDisposeTimer: () => void;
  clearWebglTextureAtlas: () => void;
  disposeWebglRenderer: () => boolean;
  scheduleFit: (force?: boolean) => void;
  scheduleViewportRefresh: () => void;
  markViewportRefreshNeeded: () => void;
  enqueueActiveWrite: (text: string, inactiveReplay?: boolean) => void;
  getOutputRestorePlanState: () => {
    inactiveBufferLength: number;
    activeWriteQueueLength: number;
    activeWriteRafScheduled: boolean;
  };
  flushInactiveBufferForReplay: () => void;
  resumeActiveWriteQueue: () => void;
  getPendingOutputSnapshot: () => string;
  attachPtyOutput: (options?: { waitForReplay?: boolean }) => {
    ready: Promise<void>;
    completeReplay: (replayBase64: string) => void;
    dispose: () => void;
  };
  attachViewport: (terminal: Terminal) => () => void;
  resetOutputState: () => void;
  cancelScheduledFit: () => void;
  resetViewportRefreshState: () => void;
}

export function useTerminalDisplay({
  sessionId,
  containerRef,
  terminalRef,
  fitAddonRef,
  isVisibleRef,
  isComposingRef,
  lowMemoryMode,
  terminalScrollbackRows,
  disableHardwareAcceleration,
  linuxGraphicsDisableWebgl,
  isTransparentRef,
  normalizeOutputRef,
  transformOutputRef,
  afterTerminalWriteRef,
  onInactiveReplayPendingChange,
  onPtyOutputListenError,
  onViewportRefreshNeeded,
}: UseTerminalDisplayOptions): UseTerminalDisplayResult {
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webglDisposeTimerRef = useRef<number | null>(null);
  const webglContextLostRef = useRef(false);
  const fitRafRef = useRef<number | null>(null);
  const needsViewportRefreshRef = useRef(false);
  const inactiveBufferLimitRef = useRef(getInactiveBufferLimit(terminalScrollbackRows));
  const inactiveBufferRef = useRef<string[]>([]);
  const inactiveBufferSizeRef = useRef(0);
  const activeWriteQueueRef = useRef<ActiveWriteQueueItem[]>([]);
  const activeWriteQueueSizeRef = useRef(0);
  const activeWriteQueueLastDropLogAtRef = useRef(0);
  const activeWriteRafRef = useRef<number | null>(null);
  const inactiveReplayStickToBottomRef = useRef(false);
  const inactiveReplayPendingWritesRef = useRef(0);
  const inactiveReplayPendingRef = useRef(false);
  const ptyPendingChunksRef = useRef<string[]>([]);
  const ptyWriteRafIdRef = useRef<number | null>(null);
  const ptyUnlistenRef = useRef<UnlistenFn | null>(null);
  const lastObservedSizeRef = useRef<{ width: number; height: number } | null>(null);

  inactiveBufferLimitRef.current = getInactiveBufferLimit(terminalScrollbackRows);

  const clearHiddenWebglDisposeTimer = () => {
    if (webglDisposeTimerRef.current === null) return;
    window.clearTimeout(webglDisposeTimerRef.current);
    webglDisposeTimerRef.current = null;
  };

  const disposeWebglRenderer = () => {
    if (!webglAddonRef.current) return false;
    webglAddonRef.current.dispose();
    webglAddonRef.current = null;
    return true;
  };

  const canUseWebglRenderer = (theme: ITheme) => (
    !disableHardwareAcceleration
    && !linuxGraphicsDisableWebgl
    && !webglContextLostRef.current
    && !isTransparentRef.current
    && !isLightTerminalTheme(theme)
  );

  const createWebglAddon = () => {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      webglContextLostRef.current = true;
      addon.dispose();
      if (webglAddonRef.current === addon) {
        webglAddonRef.current = null;
      }
      logWarn("Terminal WebGL context lost; keeping the default renderer for this session", { sessionId });
    });
    return addon;
  };

  const syncWebglRenderer = (terminal: Terminal, theme: ITheme) => {
    if (!canUseWebglRenderer(theme)) {
      return disposeWebglRenderer();
    }
    if (lowMemoryMode && !isVisibleRef.current) return false;
    if (webglAddonRef.current) return false;
    try {
      const addon = createWebglAddon();
      terminal.loadAddon(addon);
      webglAddonRef.current = addon;
      return true;
    } catch {
      return false;
    }
  };

  const scheduleHiddenWebglDispose = (enabled: boolean) => {
    clearHiddenWebglDisposeTimer();
    if (!enabled || !webglAddonRef.current) return;
    webglDisposeTimerRef.current = window.setTimeout(() => {
      webglDisposeTimerRef.current = null;
      if (isVisibleRef.current) return;
      if (disposeWebglRenderer()) {
        needsViewportRefreshRef.current = true;
        onViewportRefreshNeeded?.();
      }
    }, HIDDEN_WEBGL_DISPOSE_DELAY_MS);
  };

  const clearWebglTextureAtlas = () => {
    webglAddonRef.current?.clearTextureAtlas();
  };

  const setInactiveReplayPendingVisible = (pending: boolean) => {
    if (inactiveReplayPendingRef.current === pending) return;
    inactiveReplayPendingRef.current = pending;
    onInactiveReplayPendingChange(pending);
  };

  const hasQueuedInactiveReplay = () => activeWriteQueueRef.current.some((item) => item.inactiveReplay);

  const finishInactiveReplayIfReady = (terminal: Terminal) => {
    if (!inactiveReplayStickToBottomRef.current) return;
    if (
      hasQueuedInactiveReplay()
      || inactiveReplayPendingWritesRef.current > 0
    ) {
      return;
    }
    inactiveReplayStickToBottomRef.current = false;
    terminal.scrollToBottom();
    setInactiveReplayPendingVisible(false);
  };

  const flushActiveWriteQueue = () => {
    activeWriteRafRef.current = null;
    if (!isVisibleRef.current || activeWriteQueueRef.current.length === 0) {
      if (!isVisibleRef.current && activeWriteQueueRef.current.length > 0 && useSettingsStore.getState().debugMode) {
        logInfo("[terminal-visibility] active write flush deferred while hidden", {
          sessionId,
          queuedChars: activeWriteQueueSizeRef.current,
          queuedChunks: activeWriteQueueRef.current.length,
        });
      }
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) return;

    const writeTerminalChunk = (chunk: string, inactiveReplay: boolean) => {
      if (inactiveReplay) inactiveReplayPendingWritesRef.current += 1;
      terminal.write(chunk, () => {
        if (inactiveReplay) {
          inactiveReplayPendingWritesRef.current = Math.max(0, inactiveReplayPendingWritesRef.current - 1);
        }
        if (terminalRef.current !== terminal) return;
        if (inactiveReplay) terminal.scrollToBottom();
        afterTerminalWriteRef.current?.(terminal);
        if (inactiveReplay) finishInactiveReplayIfReady(terminal);
      });
    };

    let budget = ACTIVE_WRITE_FRAME_BUDGET;
    while (budget > 0 && activeWriteQueueRef.current.length > 0) {
      const item = activeWriteQueueRef.current[0];
      const chunk = item.text;
      if (chunk.length <= budget) {
        writeTerminalChunk(chunk, item.inactiveReplay);
        activeWriteQueueRef.current.shift();
        activeWriteQueueSizeRef.current = Math.max(0, activeWriteQueueSizeRef.current - chunk.length);
        budget -= chunk.length;
        continue;
      }
      writeTerminalChunk(chunk.slice(0, budget), item.inactiveReplay);
      activeWriteQueueRef.current[0] = { ...item, text: chunk.slice(budget) };
      activeWriteQueueSizeRef.current = Math.max(0, activeWriteQueueSizeRef.current - budget);
      budget = 0;
    }

    if (activeWriteQueueRef.current.length > 0) {
      activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
    } else {
      finishInactiveReplayIfReady(terminal);
    }
  };

  const enqueueActiveWrite = (text: string, inactiveReplay = false) => {
    if (!text) return;
    let nextText = transformOutputRef.current(text);
    let droppedChars = 0;
    if (nextText.length >= ACTIVE_WRITE_QUEUE_MAX_CHARS) {
      droppedChars += activeWriteQueueSizeRef.current + nextText.length - ACTIVE_WRITE_QUEUE_MAX_CHARS;
      nextText = nextText.slice(-ACTIVE_WRITE_QUEUE_MAX_CHARS);
      activeWriteQueueRef.current = [];
      activeWriteQueueSizeRef.current = 0;
    }
    activeWriteQueueRef.current.push({ text: nextText, inactiveReplay });
    activeWriteQueueSizeRef.current += nextText.length;
    while (activeWriteQueueSizeRef.current > ACTIVE_WRITE_QUEUE_MAX_CHARS && activeWriteQueueRef.current.length > 0) {
      const overflow = activeWriteQueueSizeRef.current - ACTIVE_WRITE_QUEUE_MAX_CHARS;
      const head = activeWriteQueueRef.current[0];
      if (!head || head.text.length <= overflow) {
        const removed = activeWriteQueueRef.current.shift();
        const removedLength = removed?.text.length ?? 0;
        activeWriteQueueSizeRef.current -= removedLength;
        droppedChars += removedLength;
        continue;
      }
      activeWriteQueueRef.current[0] = { ...head, text: head.text.slice(overflow) };
      activeWriteQueueSizeRef.current -= overflow;
      droppedChars += overflow;
    }
    if (droppedChars > 0) {
      const now = Date.now();
      if (now - activeWriteQueueLastDropLogAtRef.current >= ACTIVE_WRITE_QUEUE_LOG_INTERVAL_MS) {
        activeWriteQueueLastDropLogAtRef.current = now;
        debugConsoleWarn("[oom-diagnostics:webview]", {
          area: "xterm",
          phase: "activeWriteQueueTrim",
          sessionId,
          droppedChars,
          queuedChars: activeWriteQueueSizeRef.current,
          maxQueuedChars: ACTIVE_WRITE_QUEUE_MAX_CHARS,
          thresholdExceeded: true,
        });
      }
    }
    if (activeWriteRafRef.current === null) {
      activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
    }
  };

  const stashInactiveText = (text: string) => {
    if (!text) return;
    const maxBufferChars = inactiveBufferLimitRef.current;
    if (text.length >= maxBufferChars) {
      const suffix = text.slice(-maxBufferChars);
      inactiveBufferRef.current = [suffix];
      inactiveBufferSizeRef.current = suffix.length;
      return;
    }

    inactiveBufferRef.current.push(text);
    inactiveBufferSizeRef.current += text.length;
    while (inactiveBufferSizeRef.current > maxBufferChars && inactiveBufferRef.current.length > 0) {
      const overflow = inactiveBufferSizeRef.current - maxBufferChars;
      const head = inactiveBufferRef.current[0];
      if (!head || head.length <= overflow) {
        const removed = inactiveBufferRef.current.shift();
        if (removed) inactiveBufferSizeRef.current -= removed.length;
        continue;
      }
      inactiveBufferRef.current[0] = head.slice(overflow);
      inactiveBufferSizeRef.current -= overflow;
    }
  };

  const getOutputRestorePlanState = () => ({
    inactiveBufferLength: inactiveBufferRef.current.length,
    activeWriteQueueLength: activeWriteQueueRef.current.length,
    activeWriteRafScheduled: activeWriteRafRef.current !== null,
  });

  const flushInactiveBufferForReplay = () => {
    const terminal = terminalRef.current;
    if (!terminal || inactiveBufferRef.current.length === 0) return;
    const combined = inactiveBufferRef.current.join("");
    inactiveBufferRef.current = [];
    inactiveBufferSizeRef.current = 0;
    inactiveReplayStickToBottomRef.current = true;
    inactiveReplayPendingWritesRef.current = 0;
    setInactiveReplayPendingVisible(true);
    terminal.scrollToBottom();
    enqueueActiveWrite(combined, true);
  };

  const resumeActiveWriteQueue = () => {
    if (activeWriteRafRef.current !== null) return;
    activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
  };

  const getPendingOutputSnapshot = () => [
    ...activeWriteQueueRef.current.map((item) => item.text),
    ...ptyPendingChunksRef.current,
    ...inactiveBufferRef.current,
  ].join("");

  const attachPtyOutput = (options: { waitForReplay?: boolean } = {}) => {
    const textDecoder = new TextDecoder("utf-8");
    let cancelled = false;
    let waitingForReplay = options.waitForReplay === true;
    const bufferedLivePayloads: string[] = [];
    const flushPendingWrites = () => {
      ptyWriteRafIdRef.current = null;
      if (cancelled || ptyPendingChunksRef.current.length === 0) return;
      const combined = ptyPendingChunksRef.current.length === 1 ? ptyPendingChunksRef.current[0] : ptyPendingChunksRef.current.join("");
      ptyPendingChunksRef.current = [];
      if (isVisibleRef.current) {
        enqueueActiveWrite(combined);
      } else {
        stashInactiveText(combined);
      }
    };
    const queuePayload = (payload: string, markSnapshotDirty: boolean) => {
      const binaryString = atob(payload);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i += 1) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const text = normalizeOutputRef.current(textDecoder.decode(bytes, { stream: true }));
      if (!text) return;
      if (markSnapshotDirty) {
        markTerminalSnapshotDirty(sessionId);
        useTerminalStore.getState().recordPtyOutputActivity(sessionId);
      }
      if (isVisibleRef.current) {
        ptyPendingChunksRef.current.push(text);
        if (ptyWriteRafIdRef.current === null) {
          ptyWriteRafIdRef.current = requestAnimationFrame(flushPendingWrites);
        }
      } else {
        stashInactiveText(text);
      }
    };
    const ready = listen<string>(`pty-output-${sessionId}`, (event) => {
      if (cancelled) return;
      if (waitingForReplay) {
        bufferedLivePayloads.push(event.payload);
        return;
      }
      queuePayload(event.payload, true);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        ptyUnlistenRef.current = fn;
      }
    });
    void ready.catch(onPtyOutputListenError);

    const completeReplay = (replayBase64: string) => {
      if (cancelled || !waitingForReplay) return;
      if (replayBase64) queuePayload(replayBase64, false);
      waitingForReplay = false;
      bufferedLivePayloads.splice(0).forEach((payload) => queuePayload(payload, true));
    };
    const dispose = () => {
      cancelled = true;
      bufferedLivePayloads.length = 0;
      if (ptyWriteRafIdRef.current !== null) {
        cancelAnimationFrame(ptyWriteRafIdRef.current);
        ptyWriteRafIdRef.current = null;
      }
      ptyPendingChunksRef.current = [];
      ptyUnlistenRef.current?.();
      ptyUnlistenRef.current = null;
    };
    return { ready, completeReplay, dispose };
  };

  const attachViewport = (terminal: Terminal) => {
    const container = containerRef.current;
    if (!container) return () => {};
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) return;
      invoke("pty_resize", { sessionId, cols, rows }).catch((err) => {
        logError("PTY resize failed in terminal display", { sessionId, cols, rows, err });
      });
    });
    const wheelListenerOptions = { passive: false, capture: true } as const;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const current = useSettingsStore.getState().fontSize;
      const next = Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, current + (event.deltaY > 0 ? -1 : 1)),
      );
      if (next !== current) {
        void useSettingsStore.getState().update("fontSize", next);
      }
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      const lastSize = lastObservedSizeRef.current;
      if (lastSize && Math.abs(lastSize.width - width) < 2 && Math.abs(lastSize.height - height) < 2) {
        return;
      }
      lastObservedSizeRef.current = { width, height };
      scheduleFit();
    });
    container.addEventListener("wheel", onWheel, wheelListenerOptions);
    resizeObserver.observe(container);
    return () => {
      resizeDisposable.dispose();
      container.removeEventListener("wheel", onWheel, wheelListenerOptions);
      resizeObserver.disconnect();
    };
  };

  const resetOutputState = () => {
    if (activeWriteRafRef.current !== null) {
      cancelAnimationFrame(activeWriteRafRef.current);
      activeWriteRafRef.current = null;
    }
    if (ptyWriteRafIdRef.current !== null) {
      cancelAnimationFrame(ptyWriteRafIdRef.current);
      ptyWriteRafIdRef.current = null;
    }
    ptyPendingChunksRef.current = [];
    activeWriteQueueRef.current = [];
    activeWriteQueueSizeRef.current = 0;
    inactiveReplayStickToBottomRef.current = false;
    inactiveReplayPendingWritesRef.current = 0;
    inactiveReplayPendingRef.current = false;
    inactiveBufferRef.current = [];
    inactiveBufferSizeRef.current = 0;
    onInactiveReplayPendingChange(false);
  };

  const fitWhenStable = (force = false) => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!container || !fitAddon || !terminal) return;
    if (!force && (!isVisibleRef.current || isComposingRef.current)) return;
    if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;

    const dims = fitAddon.proposeDimensions();
    if (!dims || dims.cols < MIN_TERMINAL_COLS || dims.rows < MIN_TERMINAL_ROWS) return;
    const beforeCols = terminal.cols;
    const beforeRows = terminal.rows;
    fitAddon.fit();
    const terminalSizeChanged = terminal.cols !== beforeCols || terminal.rows !== beforeRows;
    if (force || terminalSizeChanged || needsViewportRefreshRef.current) {
      refreshTerminalViewport(terminal);
      needsViewportRefreshRef.current = false;
    }
  };

  const cancelScheduledFit = () => {
    if (fitRafRef.current === null) return;
    cancelAnimationFrame(fitRafRef.current);
    fitRafRef.current = null;
  };

  const scheduleFit = (force = false) => {
    cancelScheduledFit();
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = requestAnimationFrame(() => {
        fitRafRef.current = null;
        fitWhenStable(force);
      });
    });
  };

  const scheduleViewportRefresh = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        refreshTerminalViewport(terminal);
        scheduleFit(true);
      });
    });
  };

  const markViewportRefreshNeeded = () => {
    needsViewportRefreshRef.current = true;
  };

  const resetViewportRefreshState = () => {
    needsViewportRefreshRef.current = false;
  };

  return {
    syncWebglRenderer,
    scheduleHiddenWebglDispose,
    clearHiddenWebglDisposeTimer,
    clearWebglTextureAtlas,
    disposeWebglRenderer,
    scheduleFit,
    scheduleViewportRefresh,
    markViewportRefreshNeeded,
    enqueueActiveWrite,
    getOutputRestorePlanState,
    flushInactiveBufferForReplay,
    resumeActiveWriteQueue,
    getPendingOutputSnapshot,
    attachPtyOutput,
    attachViewport,
    resetOutputState,
    cancelScheduledFit,
    resetViewportRefreshState,
  };
}
