import { useRef, type RefObject } from "react";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { refreshTerminalViewport } from "../lib/terminalVisibility";
import { isLightTerminalTheme } from "../lib/terminalThemes";
import { logError, logWarn } from "../lib/logger";
import { markTerminalSnapshotDirty } from "../lib/sessionSnapshotPersistence";
import { TerminalResizeDebouncer } from "../terminal/browser/TerminalResizeDebouncer";
import {
  terminalProcessManager,
  type TerminalOutputDelivery,
} from "../terminal/core/TerminalProcessManager";
import type { TerminalBinaryFrame } from "../terminal/transport/PtyHostSocket";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  useSettingsStore,
} from "../stores/settingsStore";

const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 8;
const HIDDEN_WEBGL_DISPOSE_DELAY_MS = 10_000;

type NormalizeTerminalOutput = (text: string) => string;
type TransformTerminalOutput = (text: string) => string;
type AfterTerminalWrite = (terminal: Terminal) => void;

interface PendingTerminalWrite {
  text: string;
  charCount: number;
  commit: ((charCount: number) => void) | null;
  replay: boolean;
  replayBatchEnd: boolean;
  cols: number;
  rows: number;
}

interface UseTerminalDisplayOptions {
  sessionId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  isVisibleRef: RefObject<boolean>;
  isComposingRef: RefObject<boolean>;
  lowMemoryMode: boolean;
  disableHardwareAcceleration: boolean;
  linuxGraphicsDisableWebgl: boolean;
  isTransparentRef: RefObject<boolean>;
  normalizeOutputRef: RefObject<NormalizeTerminalOutput>;
  transformOutputRef: RefObject<TransformTerminalOutput>;
  afterTerminalWriteRef: RefObject<AfterTerminalWrite | null>;
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
  enqueueActiveWrite: (text: string, onCommitted?: () => void) => void;
  attachPtyOutput: (options?: { waitForReplay?: boolean }) => {
    ready: Promise<void>;
    completeReplay: (replay: TerminalBinaryFrame[]) => Promise<boolean>;
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
  disableHardwareAcceleration,
  linuxGraphicsDisableWebgl,
  isTransparentRef,
  normalizeOutputRef,
  transformOutputRef,
  afterTerminalWriteRef,
  onPtyOutputListenError,
  onViewportRefreshNeeded,
}: UseTerminalDisplayOptions): UseTerminalDisplayResult {
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webglDisposeTimerRef = useRef<number | null>(null);
  const webglContextLostRef = useRef(false);
  const fitRafRef = useRef<number | null>(null);
  const needsViewportRefreshRef = useRef(false);
  const ptyPendingChunksRef = useRef<PendingTerminalWrite[]>([]);
  const ptyWriteRafIdRef = useRef<number | null>(null);
  const ptyWriteInProgressRef = useRef(false);
  const ptyUnlistenRef = useRef<UnlistenFn | null>(null);
  const lastObservedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const resizeDebouncerRef = useRef<TerminalResizeDebouncer | null>(null);
  const forwardPtyResizeRef = useRef(true);

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

  const enqueueActiveWrite = (text: string, onCommitted?: () => void) => {
    if (!text) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.write(transformOutputRef.current(text), () => {
      if (terminalRef.current !== terminal) return;
      afterTerminalWriteRef.current?.(terminal);
      onCommitted?.();
    });
  };

  const attachPtyOutput = (options: { waitForReplay?: boolean } = {}) => {
    const textDecoder = new TextDecoder("utf-8");
    let cancelled = false;
    let waitingForReplay = options.waitForReplay === true;
    const bufferedLivePayloads: TerminalOutputDelivery[] = [];
    const finishReplayBatch = () => {
      forwardPtyResizeRef.current = true;
      fitWhenStable(true);
    };
    const schedulePendingWrite = () => {
      if (
        cancelled
        || ptyWriteInProgressRef.current
        || ptyWriteRafIdRef.current !== null
        || ptyPendingChunksRef.current.length === 0
      ) {
        return;
      }
      ptyWriteRafIdRef.current = requestAnimationFrame(flushPendingWrites);
    };
    const flushPendingWrites = () => {
      ptyWriteRafIdRef.current = null;
      if (cancelled || ptyWriteInProgressRef.current) return;
      const terminal = terminalRef.current;
      if (!terminal) return;
      const first = ptyPendingChunksRef.current.shift();
      if (!first) return;
      const pending = [first];
      if (!first.replay) {
        while (ptyPendingChunksRef.current[0] && !ptyPendingChunksRef.current[0].replay) {
          pending.push(ptyPendingChunksRef.current.shift()!);
        }
      } else {
        forwardPtyResizeRef.current = false;
        if (
          first.cols > 0
          && first.rows > 0
          && (terminal.cols !== first.cols || terminal.rows !== first.rows)
        ) {
          terminal.resize(first.cols, first.rows);
        }
      }
      const combined = pending.map((chunk) => chunk.text).join("");
      const commitPending = () => {
        pending.forEach((chunk) => chunk.commit?.(chunk.charCount));
        if (first.replay && first.replayBatchEnd) finishReplayBatch();
      };
      if (!combined) {
        commitPending();
        schedulePendingWrite();
        return;
      }
      ptyWriteInProgressRef.current = true;
      terminal.write(transformOutputRef.current(combined), () => {
        ptyWriteInProgressRef.current = false;
        if (cancelled || terminalRef.current !== terminal) return;
        afterTerminalWriteRef.current?.(terminal);
        commitPending();
        schedulePendingWrite();
      });
    };
    const queuePayload = (delivery: TerminalOutputDelivery, markSnapshotDirty: boolean) => {
      const payload = delivery.frame;
      const rawText = textDecoder.decode(payload.data, { stream: true });
      const text = normalizeOutputRef.current(rawText);
      if (!text && payload.kind !== "replay") {
        delivery.commit(rawText.length);
        return;
      }
      if (markSnapshotDirty) markTerminalSnapshotDirty(sessionId);
      ptyPendingChunksRef.current.push({
        text,
        charCount: rawText.length,
        commit: delivery.commit,
        replay: payload.kind === "replay",
        replayBatchEnd: payload.replayBatchEnd === true,
        cols: payload.cols,
        rows: payload.rows,
      });
      schedulePendingWrite();
    };
    const ready = terminalProcessManager.subscribeOutput(sessionId, (delivery) => {
      if (cancelled) return;
      if (waitingForReplay) {
        bufferedLivePayloads.push(delivery);
        return;
      }
      queuePayload(delivery, true);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        ptyUnlistenRef.current = fn;
      }
    });
    void ready.catch(onPtyOutputListenError);

    const completeReplay = async (replay: TerminalBinaryFrame[]) => {
      if (cancelled || !waitingForReplay) return false;
      const terminal = terminalRef.current;
      if (!terminal) return false;
      forwardPtyResizeRef.current = false;
      try {
        for (const entry of replay) {
          if (cancelled || terminalRef.current !== terminal) return false;
          if (entry.cols > 0 && entry.rows > 0 && (terminal.cols !== entry.cols || terminal.rows !== entry.rows)) {
            terminal.resize(entry.cols, entry.rows);
          }
          const text = normalizeOutputRef.current(textDecoder.decode(entry.data, { stream: true }));
          if (!text) {
            terminalProcessManager.acknowledgeOutput(sessionId, entry.sequence, 0);
            continue;
          }
          await new Promise<void>((resolve) => {
            terminal.write(transformOutputRef.current(text), () => {
              if (terminalRef.current === terminal) {
                afterTerminalWriteRef.current?.(terminal);
                terminalProcessManager.acknowledgeOutput(sessionId, entry.sequence, 0);
              }
              resolve();
            });
          });
        }
      } finally {
        forwardPtyResizeRef.current = true;
      }
      fitWhenStable(true);
      waitingForReplay = false;
      bufferedLivePayloads.splice(0).forEach((delivery) => queuePayload(delivery, true));
      return true;
    };
    const dispose = () => {
      cancelled = true;
      bufferedLivePayloads.length = 0;
      forwardPtyResizeRef.current = true;
      if (ptyWriteRafIdRef.current !== null) {
        cancelAnimationFrame(ptyWriteRafIdRef.current);
        ptyWriteRafIdRef.current = null;
      }
      ptyPendingChunksRef.current = [];
      ptyWriteInProgressRef.current = false;
      ptyUnlistenRef.current?.();
      ptyUnlistenRef.current = null;
    };
    return { ready, completeReplay, dispose };
  };

  const attachViewport = (terminal: Terminal) => {
    const container = containerRef.current;
    if (!container) return () => {};
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!forwardPtyResizeRef.current) return;
      if (cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) return;
      terminalProcessManager.resize(sessionId, cols, rows).catch((err) => {
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
      resizeDebouncerRef.current?.dispose();
      resizeDebouncerRef.current = null;
    };
  };

  const resetOutputState = () => {
    if (ptyWriteRafIdRef.current !== null) {
      cancelAnimationFrame(ptyWriteRafIdRef.current);
      ptyWriteRafIdRef.current = null;
    }
    ptyPendingChunksRef.current = [];
    ptyWriteInProgressRef.current = false;
    forwardPtyResizeRef.current = true;
  };

  const resizeTerminal = (terminal: Terminal, cols: number, rows: number) => {
    if (terminal.cols === cols && terminal.rows === rows) return;
    terminal.resize(cols, rows);
  };

  const getResizeDebouncer = () => {
    let debouncer = resizeDebouncerRef.current;
    if (debouncer) return debouncer;
    debouncer = new TerminalResizeDebouncer(
      () => isVisibleRef.current,
      () => terminalRef.current,
      (cols, rows) => {
        const terminal = terminalRef.current;
        if (terminal) resizeTerminal(terminal, cols, rows);
      },
      (cols) => {
        const terminal = terminalRef.current;
        if (terminal) resizeTerminal(terminal, cols, terminal.rows);
      },
      (rows) => {
        const terminal = terminalRef.current;
        if (terminal) resizeTerminal(terminal, terminal.cols, rows);
      },
    );
    resizeDebouncerRef.current = debouncer;
    return debouncer;
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
    getResizeDebouncer().resize(dims.cols, dims.rows, force);
    if (force || needsViewportRefreshRef.current) {
      refreshTerminalViewport(terminal);
      needsViewportRefreshRef.current = false;
    }
  };

  const cancelScheduledFit = () => {
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
      fitRafRef.current = null;
    }
    resizeDebouncerRef.current?.cancel();
  };

  const scheduleFit = (force = false) => {
    cancelScheduledFit();
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = null;
      fitWhenStable(force);
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
    attachPtyOutput,
    attachViewport,
    resetOutputState,
    cancelScheduledFit,
    resetViewportRefreshState,
  };
}
