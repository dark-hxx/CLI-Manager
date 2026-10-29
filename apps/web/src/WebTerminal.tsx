import { DEFAULT_DISPLAY, DISPLAY_KEY, normalizeDisplay, readDisplay, stepDisplaySize, type TerminalDisplay } from "./terminalDisplay";
import { applyTerminalDisplay } from "./terminalLayout";
import { createTerminalInputFollow, revealTerminalCell } from "./terminalCursorView";
import { translate, type TranslationKey } from "./i18n";
import { installTerminalQueryPolicy } from "../../../src/shared/lib/terminalQueryPolicy";
import { createTerminalKeyboardOptions } from "../../../src/shared/lib/terminalKeyboardProtocol";
import { createTerminalKeyRouting } from "../../../src/shared/lib/terminalKeyRouting";
import { installTerminalUnicode } from "../../../src/shared/lib/terminalUnicode";
import { createTerminalColorQueryFilter } from "../../../src/shared/lib/terminalColorQueryFilter";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { MobileTerminalInput } from "./MobileTerminalInput";
import { clipboardImageToUpload, isClipboardCopyShortcut, isClipboardPasteShortcut } from "./terminalClipboard";
import type { TerminalControlMode, TerminalOutputFrame } from "./domain";
import type { TerminalStream } from "./terminalStream";

type WebTerminalProps = {
  sessionId: string;
  active: boolean;
  status: string;
  stream: TerminalStream;
  controlMode: TerminalControlMode;
  desktopCols?: number;
  desktopRows?: number;
  theme: "light" | "dark";
  errorLabel: string;
  scrollLabel: string;
  source?: string | null;
  t?: (key: TranslationKey) => string;
  onInput: (data: string) => boolean | void;
  onResize: (cols: number, rows: number) => void;
  onImageUpload: (file: File) => Promise<string>;
  onMobileToolbarCollapsed?: (collapsed: boolean) => void;
};

type RenderBatch = {
  reset: boolean;
  cols: number;
  rows: number;
  sequence: number;
  parts: Uint8Array[];
  bytes: number;
};

const MAX_LIVE_WRITE_BYTES = 256 * 1024;
const HIDDEN_FLUSH_MS = 250;
const MAX_BATCHES_PER_TICK = 8;
const TERMINAL_RESET = new Uint8Array([0x1b, 0x63]);

function decodeBase64(value: string): Uint8Array {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function mergeParts(parts: Uint8Array[], bytes: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

function appendFrame(batches: RenderBatch[], frame: TerminalOutputFrame, reset = false) {
  const data = frame.data ? decodeBase64(frame.data) : new Uint8Array();
  const previous = batches.at(-1);
  if (!reset && previous && !previous.reset && previous.cols === frame.cols && previous.rows === frame.rows
    && previous.bytes + data.byteLength <= MAX_LIVE_WRITE_BYTES) {
    if (data.byteLength) previous.parts.push(data);
    previous.bytes += data.byteLength;
    if (frame.sequenceEnd !== false) previous.sequence = Math.max(previous.sequence, frame.sequence);
    return;
  }
  batches.push({
    reset,
    cols: frame.cols,
    rows: frame.rows,
    sequence: frame.sequenceEnd === false ? 0 : frame.sequence,
    parts: data.byteLength ? [data] : [],
    bytes: data.byteLength,
  });
}

export function WebTerminal({ sessionId, active, status, stream, controlMode, desktopCols, desktopRows, theme, source, errorLabel, scrollLabel, onInput, onResize, onImageUpload, onMobileToolbarCollapsed, t = (key) => translate("zh-CN", key) }: WebTerminalProps) {
  const [display, setDisplay] = useState(readDisplay);
  const [actualFontSize, setActualFontSize] = useState<number | null>(null);
  const displayRef = useRef(display);
  displayRef.current = display;
  const shellRef = useRef<HTMLDivElement>(null);
  const updateDisplay = (patch: Partial<TerminalDisplay>) => {
    const next = normalizeDisplay({ ...displayRef.current, ...patch });
    displayRef.current = next;
    setDisplay(next);
    try {
      localStorage.setItem(DISPLAY_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(DISPLAY_KEY));
    } catch { /* Keep controls usable when browser storage is blocked. */ }
  };
  const [renderFailed, setRenderFailed] = useState(false);
  const [scrolledAway, setScrolledAway] = useState(false);
  const [outerScrolledAway, setOuterScrolledAway] = useState(false);
  const [imageStatus, setImageStatus] = useState<"sending" | "submitted" | "failed" | null>(null);
  const imageSending = useRef(false);
  const inputRejected = useRef(false);
  const uploadImage = async (file: File) => {
    if (!enabledRef.current || imageSending.current) return;
    imageSending.current = true;
    setImageStatus("sending");
    const target = terminalRef.current;
    try {
      const pasteText = await onImageUpload(file);
      if (!target || terminalRef.current !== target || !enabledRef.current) throw new Error("terminal_no_longer_active");
      inputRejected.current = false;
      target.paste(pasteText);
      if (inputRejected.current) throw new Error("terminal_disconnected");
      setImageStatus("submitted");
    } catch {
      setImageStatus("failed");
    } finally {
      imageSending.current = false;
    }
  };
  const uploadRef = useRef(uploadImage);
  uploadRef.current = uploadImage;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const inputRef = useRef(onInput);
  const followInputRef = useRef<((data: string) => void) | null>(null);
  const cursorVisibleRef = useRef(true);
  const resizeRef = useRef(onResize);
  const controlModeRef = useRef(controlMode);
  const desktopGeometryRef = useRef<{ cols: number; rows: number } | null>(null);
  const activeRef = useRef(active);
  const enabledRef = useRef(active && status === "running");
  enabledRef.current = active && status === "running";
  const sourceRef = useRef(source);
  const layoutRef = useRef<(() => void) | null>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const invalidateLayoutRef = useRef<(() => void) | null>(null);
  sourceRef.current = source;
  inputRef.current = (data) => {
    const accepted = onInput(data);
    followInputRef.current?.(accepted === false ? "" : data);
    return accepted;
  };
  resizeRef.current = onResize;
  controlModeRef.current = controlMode;
  desktopGeometryRef.current = controlMode === "desktop" && desktopCols && desktopRows
    ? { cols: desktopCols, rows: desktopRows }
    : null;
  activeRef.current = active;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      ...createTerminalKeyboardOptions(),
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 14,
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: theme === "dark"
        ? { background: "#0b0d10", foreground: "#e7ebf0", cursor: "#f4f6f8", selectionBackground: "#315b7d99" }
        : { background: "#111418", foreground: "#edf1f5", cursor: "#ffffff", selectionBackground: "#3d709999" },
    });
    installTerminalUnicode(terminal);
    terminal.open(container);
    const keyRouting = createTerminalKeyRouting(terminal, (data, userInput) => terminal.input(data, userInput));
    const releaseConsumedKeys = () => keyRouting.release();
    terminal.textarea?.addEventListener("blur", releaseConsumedKeys);
    window.addEventListener("blur", releaseConsumedKeys);
    terminal.attachCustomKeyEventHandler(keyRouting.wrap((event) => {
      // Let the browser dispatch copy/paste; do not send clipboard shortcuts to the PTY.
      // Pair the consumed press even if selection/modifiers change before keyup.
      if (isClipboardPasteShortcut(event)) return false;
      if (isClipboardCopyShortcut(event, terminal.hasSelection())) return false;
      return true;
    }, () => false));
    // Desktop xterm owns protocol replies even in hidden tabs; Web is a mirror.
    const queryPolicy = installTerminalQueryPolicy(terminal, () => false);
    const colorQueries = createTerminalColorQueryFilter();
    let colorDecoder = new TextDecoder();
    terminalRef.current = terminal;
    setRenderFailed(false);

    let queuedChunks: Array<{ sequence: number; frames: TerminalOutputFrame[] }> = [];
    let renderQueue: RenderBatch[] = [];
    let replayFrames: TerminalOutputFrame[] | null = null;
    let partialFrames: TerminalOutputFrame[] = [];
    let acceptedSequence = 0;
    let lastChunkSequence = 0;
    let animationFrame: number | null = null;
    let hiddenFlushTimer: number | null = null;
    let draining = false;
    let disposed = false;
    let releasePendingWrite: (() => void) | null = null;
    let cursorShowTimer: number | null = null;
    let permitCursorShow = false;
    cursorVisibleRef.current = true;
    const cancelCursorShow = () => {
      if (cursorShowTimer !== null) clearTimeout(cursorShowTimer);
      cursorShowTimer = null;
    };
    // Parse complete CSI sequences, including those split across network chunks.
    const cursorHide = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(25)) { cancelCursorShow(); cursorVisibleRef.current = false; }
      return false;
    });
    const cursorShow = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (!params.includes(25)) return false;
      if (sourceRef.current !== "codex" || params.length !== 1) { cursorVisibleRef.current = true; return false; }
      if (permitCursorShow) { permitCursorShow = false; cursorVisibleRef.current = true; return false; }
      cursorVisibleRef.current = false;
      cancelCursorShow();
      cursorShowTimer = window.setTimeout(() => {
        cursorShowTimer = null;
        if (disposed) return;
        permitCursorShow = true;
        terminal.write("\x1b[?25h");
      }, 80);
      return true;
    });
    const cursorReset = terminal.parser.registerEscHandler({ final: "c" }, () => {
      cancelCursorShow();
      cursorVisibleRef.current = true;
      followInputRef.current?.("");
      return false;
    });

    const write = (data: Uint8Array) => new Promise<void>((resolve) => {
      if (!data.byteLength || disposed) {
        resolve();
        return;
      }
      const complete = () => {
        if (releasePendingWrite === complete) releasePendingWrite = null;
        resolve();
      };
      releasePendingWrite = complete;
      const filtered = colorQueries.feed(colorDecoder.decode(data, { stream: true }));
      if (filtered) terminal.write(filtered, complete);
      else complete();
    });

    const drain = async () => {
      if (draining || disposed) return;
      draining = true;
      try {
        let batchesProcessed = 0;
        while (!disposed && renderQueue.length && batchesProcessed < MAX_BATCHES_PER_TICK) {
          const batch = renderQueue.shift()!;
          batchesProcessed += 1;
          if (batch.cols > 0 && batch.rows > 0 && (terminal.cols !== batch.cols || terminal.rows !== batch.rows)) {
            terminal.resize(batch.cols, batch.rows);
            scheduleSize();
          }
          if (batch.reset) {
            cancelCursorShow();
            colorQueries.reset();
            colorDecoder = new TextDecoder();
          }
          const parts = batch.reset ? [TERMINAL_RESET, ...batch.parts] : batch.parts;
          await write(mergeParts(parts, batch.bytes + (batch.reset ? TERMINAL_RESET.byteLength : 0)));
          if (disposed) return;
          if (batch.sequence > 0) {
            stream.markRendered(sessionId, batch.sequence);
            container.dataset.renderedSequence = String(batch.sequence);
          }
          if (batch.reset) setRenderFailed(false);
        }
      } catch (error) {
        if (!disposed) {
          console.error("Web terminal rendering failed", { sessionId, error });
          setRenderFailed(true);
        }
      } finally {
        draining = false;
        if (!disposed && renderQueue.length) scheduleFlush();
        if (!disposed && !renderQueue.length) {
          const geometry = !replayFrames && !queuedChunks.length && !partialFrames.length
            ? desktopGeometryRef.current
            : null;
          if (geometry && (terminal.cols !== geometry.cols || terminal.rows !== geometry.rows)) {
            terminal.resize(geometry.cols, geometry.rows);
          }
          scheduleSize();
        }
      }
    };

    const scheduleFlush = () => {
      if (disposed || (animationFrame !== null) || (hiddenFlushTimer !== null)) return;
      if (document.visibilityState === "hidden" || !activeRef.current) {
        hiddenFlushTimer = window.setTimeout(() => {
          hiddenFlushTimer = null;
          flush();
        }, HIDDEN_FLUSH_MS);
      } else {
        animationFrame = requestAnimationFrame(flush);
      }
    };

    const flush = () => {
      animationFrame = null;
      const chunks = queuedChunks;
      queuedChunks = [];
      const batches: RenderBatch[] = [];
      for (const chunk of chunks) {
        if (chunk.sequence <= lastChunkSequence) continue;
        lastChunkSequence = chunk.sequence;
        for (const frame of chunk.frames) {
          if (frame.kind === "reset") {
            partialFrames = [];
            acceptedSequence = 0;
            replayFrames = [];
            if (frame.replayBatchEnd) {
              appendFrame(batches, frame, true);
              replayFrames = null;
            }
            continue;
          }
          // A reconnect resends the entire source frame, never its remaining
          // bytes. Keep fragments atomic and discard a previous partial attempt.
          if (frame.sequenceStart === true || (partialFrames.length && (
            partialFrames[0]!.sequence !== frame.sequence || partialFrames[0]!.kind !== frame.kind
          ))) partialFrames = [];
          if (frame.sequence > 0 && frame.sequence <= acceptedSequence) continue;
          partialFrames.push(frame);
          if (frame.sequenceEnd === false) continue;
          const completeFrames = partialFrames;
          partialFrames = [];
          acceptedSequence = Math.max(acceptedSequence, frame.sequence);
          if (replayFrames) {
            replayFrames.push(...completeFrames);
            if (!frame.replayBatchEnd) continue;
            // Replaying old bytes at the final grid corrupts wrapping and cursor rows.
            replayFrames.forEach((entry, index) => appendFrame(batches, entry, index === 0));
            replayFrames = null;
            continue;
          }
          completeFrames.forEach((entry) => appendFrame(batches, entry));
        }
      }
      for (const batch of batches) {
        const previous = renderQueue.at(-1);
        if (!batch.reset && previous && !previous.reset && previous.cols === batch.cols && previous.rows === batch.rows
          && previous.bytes + batch.bytes <= MAX_LIVE_WRITE_BYTES) {
          previous.parts.push(...batch.parts);
          previous.bytes += batch.bytes;
          previous.sequence = Math.max(previous.sequence, batch.sequence);
        } else {
          renderQueue.push(batch);
        }
      }
      void drain();
    };

    let unsubscribe = () => {};
    // StrictMode cleans up its probe mount before this microtask. Do not drain
    // buffered replay into a renderer that will be disposed before its first frame.
    queueMicrotask(() => {
      if (disposed) return;
      unsubscribe = stream.subscribe(sessionId, (chunk) => {
        if (disposed || chunk.sequence <= lastChunkSequence) return;
        queuedChunks.push(chunk);
        scheduleFlush();
      });
    });

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && hiddenFlushTimer !== null) {
        window.clearTimeout(hiddenFlushTimer);
        hiddenFlushTimer = null;
      }
      if (queuedChunks.length || renderQueue.length) scheduleFlush();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const reportSize = () => {
      if (!activeRef.current) return;
      const padding = getComputedStyle(container);
      const availableWidth = container.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
      const availableHeight = container.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
      if (availableWidth <= 0 || availableHeight <= 0) return;
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      const element = terminal.element;
      if (!screen || !element || !screen.offsetWidth || !screen.offsetHeight) return;
      const ownsSize = controlModeRef.current === "web";
      if (!ownsSize) lastReportedSize = "";
      // Replay must be parsed at its recorded grid, not the user's new font grid.
      if (ownsSize && (draining || replayFrames || renderQueue.length || queuedChunks.length)) return;
      const prefs = displayRef.current;
      const layoutKey = () => `${availableWidth}:${availableHeight}:${terminal.cols}:${terminal.rows}:${window.devicePixelRatio}:${ownsSize}:${prefs.mode}:${prefs.fontSize}:${prefs.zoom}`;
      const layout = layoutKey();
      if (layout === lastDesktopLayout) return;
      const followBottom = container.scrollHeight - container.clientHeight - container.scrollTop <= 1;
      const result = applyTerminalDisplay(terminal, screen, availableWidth, availableHeight, prefs, ownsSize);
      if (!result) return;
      if (ownsSize) {
        const requested = `${result.cols}:${result.rows}`;
        if (requested !== lastReportedSize) {
          lastReportedSize = requested;
          resizeRef.current(result.cols, result.rows);
        }
      }
      setActualFontSize(result.fontSize);
      element.style.width = `${result.width}px`;
      element.style.height = `${result.height}px`;
      container.dataset.verticalOverflow = String(result.height > availableHeight);
      if (followBottom) container.scrollTop = container.scrollHeight;
      setOuterScrolledAway(container.scrollHeight - container.clientHeight - container.scrollTop > 1);
      lastDesktopLayout = layoutKey();
    };
    let lastReportedSize = "";
    let lastDesktopLayout = "";
    let sizeFrame: number | null = null;
    const scheduleSize = () => {
      if (sizeFrame !== null || disposed) return;
      sizeFrame = requestAnimationFrame(() => { sizeFrame = null; if (!disposed) reportSize(); });
    };
    const input = terminal.onData((data) => {
      if (enabledRef.current && inputRef.current(data) === false) inputRejected.current = true;
    });
    layoutRef.current = scheduleSize;
    invalidateLayoutRef.current = () => {
      lastReportedSize = "";
      lastDesktopLayout = "";
      scheduleSize();
    };
    wakeRef.current = () => {
      if (hiddenFlushTimer !== null) { clearTimeout(hiddenFlushTimer); hiddenFlushTimer = null; }
      if (queuedChunks.length || renderQueue.length) scheduleFlush();
    };
    const scroll = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      setScrolledAway(buffer.viewportY < buffer.baseY);
    });
    const observer = new ResizeObserver(scheduleSize);
    observer.observe(container);
    if (shellRef.current) observer.observe(shellRef.current);
    const zoom = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        if (container.dataset.verticalOverflow !== "true" || !event.deltaY || event.shiftKey) return;
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1);
        const before = container.scrollTop;
        container.scrollTop += delta;
        if (container.scrollTop === before) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY) updateDisplay(stepDisplaySize(displayRef.current, event.deltaY < 0 ? 1 : -1, terminal.options.fontSize));
    };
    container.addEventListener("wheel", zoom, { passive: false, capture: true });
    const resizeFrame = requestAnimationFrame(reportSize);
    if (enabledRef.current && !window.matchMedia("(pointer: coarse), (max-width: 767px)").matches) terminal.focus();

    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      container.removeEventListener("wheel", zoom, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelAnimationFrame(resizeFrame);
      if (sizeFrame !== null) cancelAnimationFrame(sizeFrame);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (hiddenFlushTimer !== null) window.clearTimeout(hiddenFlushTimer);
      terminal.textarea?.removeEventListener("blur", releaseConsumedKeys);
      window.removeEventListener("blur", releaseConsumedKeys);
      keyRouting.dispose();
      input.dispose();
      queryPolicy.dispose();
      cancelCursorShow();
      cursorHide.dispose();
      cursorShow.dispose();
      cursorReset.dispose();
      layoutRef.current = null;
      wakeRef.current = null;
      scroll.dispose();
      terminalRef.current = null;
      releasePendingWrite?.();
      releasePendingWrite = null;
      terminal.dispose();
    };
  }, [sessionId, stream]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) return;
    const follow = createTerminalInputFollow();
    let frame: number | null = null;
    const reveal = () => {
      if (!activeRef.current || !follow.canReveal(Date.now(), cursorVisibleRef.current) || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!activeRef.current || !follow.canReveal(Date.now(), cursorVisibleRef.current)) return;
        const screen = container.querySelector<HTMLElement>(".xterm-screen");
        if (!screen) return;
        terminal.scrollToBottom();
        const buffer = terminal.buffer.active;
        const bounds = screen.getBoundingClientRect();
        const host = container.getBoundingClientRect();
        const cellWidth = bounds.width / terminal.cols;
        const cellHeight = bounds.height / terminal.rows;
        const x = bounds.left - host.left - container.clientLeft + container.scrollLeft
          + Math.min(buffer.cursorX, terminal.cols - 1) * cellWidth;
        const y = bounds.top - host.top - container.clientTop + container.scrollTop
          + (buffer.baseY + buffer.cursorY - buffer.viewportY) * cellHeight;
        container.scrollLeft = revealTerminalCell(container.scrollLeft, container.clientWidth - 16, x, cellWidth);
        container.scrollTop = revealTerminalCell(container.scrollTop, container.clientHeight, y, cellHeight);
      });
    };
    followInputRef.current = (data) => follow.input(data, Date.now());
    // Wait for parsed output: intermediate cursor moves belong to the TUI painter.
    const parsed = terminal.onWriteParsed(reveal);
    const cancelFollow = () => follow.cancel();
    container.addEventListener("touchstart", cancelFollow, { passive: true });
    container.addEventListener("pointerdown", cancelFollow);
    container.addEventListener("wheel", cancelFollow, { passive: true });
    return () => {
      followInputRef.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
      parsed.dispose();
      container.removeEventListener("touchstart", cancelFollow);
      container.removeEventListener("pointerdown", cancelFollow);
      container.removeEventListener("wheel", cancelFollow);
    };
  }, [sessionId, stream, active]);

  useEffect(() => {
    invalidateLayoutRef.current?.();
  }, [active, controlMode]);

  useEffect(() => {
    if (controlMode !== "desktop" || !desktopCols || !desktopRows) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (terminal.cols !== desktopCols || terminal.rows !== desktopRows) {
      terminal.resize(desktopCols, desktopRows);
    }
    invalidateLayoutRef.current?.();
    let repaintFrame: number | null = null;
    const layoutFrame = requestAnimationFrame(() => {
      invalidateLayoutRef.current?.();
      repaintFrame = requestAnimationFrame(() => {
        const current = terminalRef.current;
        if (activeRef.current && current && current.rows > 0) current.refresh(0, current.rows - 1);
      });
    });
    return () => {
      cancelAnimationFrame(layoutFrame);
      if (repaintFrame !== null) cancelAnimationFrame(repaintFrame);
    };
  }, [controlMode, desktopCols, desktopRows, active]);

  useEffect(() => {
    layoutRef.current?.();
  }, [display]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onPaste = (event: ClipboardEvent) => {
      const image = clipboardImageToUpload(event.clipboardData);
      if (!image) return;
      event.preventDefault();
      event.stopPropagation();
      void uploadRef.current(image);
    };
    container.addEventListener("paste", onPaste, true);
    return () => container.removeEventListener("paste", onPaste, true);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let horizontal = false;
    let previousY = 0;
    let pendingLines = 0;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      previousY = touch.clientY;
      pendingLines = 0;
      startScrollLeft = container.scrollLeft;
      horizontal = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.15) horizontal = true;
      if (!horizontal && container.dataset.verticalOverflow === "true" && Math.abs(dy) > 8) {
        event.preventDefault();
        event.stopPropagation();
        const delta = previousY - touch.clientY;
        previousY = touch.clientY;
        const before = container.scrollTop;
        container.scrollTop += delta;
        const terminal = terminalRef.current;
        if (terminal) {
          const rowHeight = (container.querySelector<HTMLElement>(".xterm-screen")?.offsetHeight ?? 0) / terminal.rows || 16;
          pendingLines += (delta - (container.scrollTop - before)) / rowHeight;
          const lines = Math.trunc(pendingLines);
          if (lines) { terminal.scrollLines(lines); pendingLines -= lines; }
        }
        return;
      }
      if (!horizontal || container.scrollWidth <= container.clientWidth) return;
      event.preventDefault();
      event.stopPropagation();
      container.scrollLeft = startScrollLeft - dx;
    };
    const reset = () => { horizontal = false; };
    container.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    container.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    container.addEventListener("touchend", reset, { capture: true, passive: true });
    container.addEventListener("touchcancel", reset, { capture: true, passive: true });
    return () => {
      container.removeEventListener("touchstart", onTouchStart, true);
      container.removeEventListener("touchmove", onTouchMove, true);
      container.removeEventListener("touchend", reset, true);
      container.removeEventListener("touchcancel", reset, true);
    };
  }, []);

  useEffect(() => {
    const sync = () => setDisplay(readDisplay());
    const storage = (event: StorageEvent) => { if (event.key === DISPLAY_KEY || event.key === null) sync(); };
    window.addEventListener(DISPLAY_KEY, sync);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener(DISPLAY_KEY, sync); window.removeEventListener("storage", storage); };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = theme === "dark"
      ? { background: "#0b0d10", foreground: "#e7ebf0", cursor: "#f4f6f8", selectionBackground: "#315b7d99" }
      : { background: "#111418", foreground: "#edf1f5", cursor: "#ffffff", selectionBackground: "#3d709999" };
  }, [theme]);

  useEffect(() => {
    layoutRef.current?.();
  }, [controlMode]);

  useEffect(() => {
    if (!active) { terminalRef.current?.blur(); return; }
    wakeRef.current?.();
    layoutRef.current?.();
    // Safari can keep the canvas bitmap blank while this tab is hidden even
    // though xterm has already parsed the output into its buffer. Repaint only
    // after React has made the tab visible and the queued layout frame ran.
    const repaintFrame = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      if (activeRef.current && terminal && terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
    });
    if (status === "running" && !window.matchMedia("(pointer: coarse), (max-width: 767px)").matches) terminalRef.current?.focus();
    return () => cancelAnimationFrame(repaintFrame);
  }, [active, status, controlMode]);

  return <div className="web-terminal-shell" ref={shellRef}>
    {renderFailed && <div role="alert">{errorLabel}</div>}
    <details className="web-terminal-display" onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.open = false; }}>
      <summary>{t("terminalDisplay")}</summary>
      <div className="web-terminal-display-panel">
        <p>{t("terminalDisplaySharedHint")}</p>
        <label>{t("terminalDisplayFont")}
          <output>{Number((actualFontSize ?? display.fontSize).toFixed(1))}px</output>
          <input data-display-font type="range" min="1" max="36" step="1"
            value={actualFontSize ?? display.fontSize}
            onChange={(event) => updateDisplay({ mode: "manual", fontSize: Number(event.target.value) })} />
        </label>
        <p>{t("terminalDisplayActualFont")}: {actualFontSize === null ? "—" : `${Number(actualFontSize.toFixed(1))}px`}</p>
        <div className="web-terminal-display-buttons">
          <button type="button" aria-label={t("terminalDisplaySmaller")}
            onClick={() => updateDisplay(stepDisplaySize(displayRef.current, -1, actualFontSize ?? display.fontSize))}>−</button>
          <button type="button" aria-label={t("terminalDisplayLarger")}
            onClick={() => updateDisplay(stepDisplaySize(displayRef.current, 1, actualFontSize ?? display.fontSize))}>+</button>
          <button type="button" data-display-fit aria-pressed={display.mode !== "manual"}
            onClick={() => updateDisplay({ mode: "width", fontSize: 14, zoom: 100 })}>{t("terminalDisplayWidth")}</button>
        </div>
        <button data-display-reset type="button" onClick={() => updateDisplay(DEFAULT_DISPLAY)}>{t("terminalDisplayReset")}</button>
      </div>
    </details>
    <div className="web-terminal-display-area">
      <div className="web-terminal" ref={containerRef} data-status={status}
        onScroll={(event) => { const host = event.currentTarget; setOuterScrolledAway(host.scrollHeight - host.clientHeight - host.scrollTop > 1); }} />
    </div>
    <MobileTerminalInput enabled={active && status === "running"} t={t}
      onFocus={() => { if (enabledRef.current) terminalRef.current?.focus(); }}
      onPaste={(text) => { if (enabledRef.current) terminalRef.current?.paste(text); }}
      onKey={(key) => { if (enabledRef.current) inputRef.current(key); }}
      onImageUpload={(file) => { void uploadImage(file); }}
      onCollapsedChange={onMobileToolbarCollapsed} />
    {active && imageStatus && imageStatus !== "submitted" && <div className="terminal-image-status" role={imageStatus === "failed" ? "alert" : "status"}>
      {t(imageStatus === "sending" ? "terminalImageSending" : "terminalImageFailed")}
      {imageStatus !== "sending" && <button type="button" onClick={() => setImageStatus(null)}>{t("close")}</button>}
    </div>}
    {active && (scrolledAway || outerScrolledAway) && <button className="web-terminal-scroll-bottom" type="button" onClick={() => {
      terminalRef.current?.scrollToBottom();
      const host = containerRef.current;
      if (host) host.scrollTop = host.scrollHeight;
    }} aria-label={scrollLabel} title={scrollLabel}><ArrowDown size={16} aria-hidden="true" /></button>}
  </div>;
}
