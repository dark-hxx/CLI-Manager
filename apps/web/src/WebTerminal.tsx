import { DEFAULT_DISPLAY, DISPLAY_KEY, normalizeDisplay, readDisplay, type TerminalDisplay } from "./terminalDisplay";
import { translate, type TranslationKey } from "./i18n";
import { installTerminalQueryPolicy } from "../../../src/shared/lib/terminalQueryPolicy";
import { createTerminalColorQueryFilter } from "../../../src/shared/lib/terminalColorQueryFilter";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { MobileTerminalInput } from "./MobileTerminalInput";
import type { TerminalControlMode, TerminalOutputFrame } from "./domain";
import type { TerminalStream } from "./terminalStream";

type WebTerminalProps = {
  sessionId: string;
  active: boolean;
  status: string;
  stream: TerminalStream;
  controlMode: TerminalControlMode;
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

export function WebTerminal({ sessionId, active, status, stream, controlMode, theme, source, errorLabel, scrollLabel, onInput, onResize, onImageUpload, onMobileToolbarCollapsed, t = (key) => translate("zh-CN", key) }: WebTerminalProps) {
  const [display, setDisplay] = useState(readDisplay);
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
  const resizeRef = useRef(onResize);
  const controlModeRef = useRef(controlMode);
  const activeRef = useRef(active);
  const enabledRef = useRef(active && status === "running");
  enabledRef.current = active && status === "running";
  const sourceRef = useRef(source);
  const layoutRef = useRef<(() => void) | null>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const invalidateLayoutRef = useRef<(() => void) | null>(null);
  sourceRef.current = source;
  inputRef.current = onInput;
  resizeRef.current = onResize;
  controlModeRef.current = controlMode;
  activeRef.current = active;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      allowProposedApi: false,
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
    terminal.open(container);
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
    const cancelCursorShow = () => {
      if (cursorShowTimer !== null) clearTimeout(cursorShowTimer);
      cursorShowTimer = null;
    };
    // Parse complete CSI sequences, including those split across network chunks.
    const cursorHide = terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(25)) cancelCursorShow();
      return false;
    });
    const cursorShow = terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (sourceRef.current !== "codex" || params.length !== 1 || params[0] !== 25) return false;
      if (permitCursorShow) { permitCursorShow = false; return false; }
      cancelCursorShow();
      cursorShowTimer = window.setTimeout(() => {
        cursorShowTimer = null;
        if (disposed) return;
        permitCursorShow = true;
        terminal.write("\x1b[?25h");
      }, 80);
      return true;
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
        if (!disposed && !renderQueue.length) scheduleSize();
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

    const unsubscribe = stream.subscribe(sessionId, (chunk) => {
      if (disposed || chunk.sequence <= lastChunkSequence) return;
      queuedChunks.push(chunk);
      scheduleFlush();
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
      const shell = shellRef.current;
      if (!screen || !element || !shell || !screen.offsetWidth || !screen.offsetHeight) return;
      // Web ownership keeps its existing automatic grid, based on the OUTER
      // workspace at 14px. Display controls never feed back into the PTY size.
      const workspace = `${shell.clientWidth}:${shell.clientHeight}:${window.devicePixelRatio}`;
      if (controlModeRef.current !== "web") lastReportedSize = "";
      if (controlModeRef.current === "web" && workspace !== lastReportedSize) {
        if (draining || replayFrames || renderQueue.length || queuedChunks.length) return;
        terminal.options.fontSize = 14;
        lastDesktopLayout = "";
        const cols = Math.max(2, Math.min(500, Math.floor((shell.clientWidth - 28) / (screen.offsetWidth / terminal.cols))));
        const rows = Math.max(1, Math.min(300, Math.floor((shell.clientHeight - 10) / (screen.offsetHeight / terminal.rows))));
        terminal.resize(cols, rows);
        lastReportedSize = workspace;
        resizeRef.current(cols, rows);
      }
      const prefs = displayRef.current;
      const layout = `${availableWidth}:${availableHeight}:${terminal.cols}:${terminal.rows}:${window.devicePixelRatio}:${prefs.mode}:${prefs.fontSize}`;
      if (layout === lastDesktopLayout) return;
      const followBottom = container.scrollHeight - container.clientHeight - container.scrollTop <= 1;
      terminal.options.fontSize = prefs.fontSize;
      const widthLimit = Math.max(1, availableWidth - 16);
      if (prefs.mode !== "manual") {
        const ratio = prefs.mode === "width" ? widthLimit / screen.offsetWidth
          : Math.min(1, widthLimit / screen.offsetWidth, availableHeight / screen.offsetHeight);
        terminal.options.fontSize = Math.max(1, Math.min(96, Math.floor(prefs.fontSize * ratio * 10) / 10));
        // Pixel-rounded row metrics must also keep the last input row visible.
        for (let attempt = 0; attempt < 32 && terminal.options.fontSize! > 1 &&
          (screen.offsetWidth > widthLimit || (prefs.mode === "contain" && screen.offsetHeight > availableHeight)); attempt++) {
          terminal.options.fontSize = Math.max(1, terminal.options.fontSize - 0.1);
        }
      }
      element.style.width = `${screen.offsetWidth + 16}px`;
      element.style.height = `${screen.offsetHeight}px`;
      container.dataset.verticalOverflow = String(screen.offsetHeight > availableHeight);
      if (followBottom) container.scrollTop = container.scrollHeight;
      setOuterScrolledAway(container.scrollHeight - container.clientHeight - container.scrollTop > 1);
      lastDesktopLayout = layout;
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
      updateDisplay({ mode: "manual", fontSize: displayRef.current.fontSize + (event.deltaY < 0 ? 1 : -1) });
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
      input.dispose();
      queryPolicy.dispose();
      cancelCursorShow();
      cursorHide.dispose();
      cursorShow.dispose();
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
    invalidateLayoutRef.current?.();
  }, [active, controlMode]);

  useEffect(() => {
    layoutRef.current?.();
  }, [display]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onPaste = (event: ClipboardEvent) => {
      const image = Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith("image/"));
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
        <p>{t("terminalDisplayHint")}</p>
        <label>{t("terminalDisplayMode")}<select data-display-mode value={display.mode} onChange={(event) => updateDisplay({ mode: event.target.value as TerminalDisplay["mode"] })}>
          <option value="manual">{t("terminalDisplayManual")}</option><option value="width">{t("terminalDisplayWidth")}</option><option value="contain">{t("terminalDisplayContain")}</option>
        </select></label>
        <label>{t("terminalDisplayFont")} <output>{display.fontSize}px</output><input data-display-font type="range" min="8" max="36" value={display.fontSize} onChange={(event) => updateDisplay({ fontSize: Number(event.target.value), mode: "manual" })} /></label>
        <div className="web-terminal-display-buttons"><button type="button" aria-label={t("terminalDisplaySmaller")} onClick={() => updateDisplay({ mode: "manual", fontSize: display.fontSize - 1 })}>−</button><button type="button" aria-label={t("terminalDisplayLarger")} onClick={() => updateDisplay({ mode: "manual", fontSize: display.fontSize + 1 })}>+</button></div>
        <label>{t("terminalDisplayAreaWidth")} <output>{display.width}%</output><input data-display-width type="range" min="30" max="100" value={display.width} onChange={(event) => updateDisplay({ width: Number(event.target.value) })} /></label>
        <label>{t("terminalDisplayAreaHeight")} <output>{display.height}%</output><input data-display-height type="range" min="30" max="100" value={display.height} onChange={(event) => updateDisplay({ height: Number(event.target.value) })} /></label>
        <button data-display-reset type="button" onClick={() => updateDisplay(DEFAULT_DISPLAY)}>{t("terminalDisplayReset")}</button>
      </div>
    </details>
    <div className="web-terminal-display-area" style={{ width: `${display.width}%`, height: `${display.height}%` }}>
      <div className="web-terminal" ref={containerRef} data-status={status}
        onScroll={(event) => { const host = event.currentTarget; setOuterScrolledAway(host.scrollHeight - host.clientHeight - host.scrollTop > 1); }} />
    </div>
    <MobileTerminalInput enabled={active && status === "running"} t={t}
      onFocus={() => { if (enabledRef.current) terminalRef.current?.focus(); }}
      onPaste={(text) => { if (enabledRef.current) terminalRef.current?.paste(text); }}
      onKey={(key) => { if (enabledRef.current) inputRef.current(key); }}
      onImageUpload={(file) => { void uploadImage(file); }}
      onCollapsedChange={onMobileToolbarCollapsed} />
    {active && imageStatus && <div className="terminal-image-status" role={imageStatus === "failed" ? "alert" : "status"}>
      {t(imageStatus === "sending" ? "terminalImageSending" : imageStatus === "submitted" ? "terminalImageSubmitted" : "terminalImageFailed")}
      {imageStatus !== "sending" && <button type="button" onClick={() => setImageStatus(null)}>{t("close")}</button>}
    </div>}
    {active && (scrolledAway || outerScrolledAway) && <button className="web-terminal-scroll-bottom" type="button" onClick={() => {
      terminalRef.current?.scrollToBottom();
      const host = containerRef.current;
      if (host) host.scrollTop = host.scrollHeight;
    }} aria-label={scrollLabel} title={scrollLabel}><ArrowDown size={16} aria-hidden="true" /></button>}
  </div>;
}
