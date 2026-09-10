import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
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
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
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
    previous.sequence = Math.max(previous.sequence, frame.sequence);
    return;
  }
  batches.push({
    reset,
    cols: frame.cols,
    rows: frame.rows,
    sequence: frame.sequence,
    parts: data.byteLength ? [data] : [],
    bytes: data.byteLength,
  });
}

export function WebTerminal({ sessionId, active, status, stream, controlMode, theme, errorLabel, scrollLabel, onInput, onResize }: WebTerminalProps) {
  const [renderFailed, setRenderFailed] = useState(false);
  const [scrolledAway, setScrolledAway] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  const controlModeRef = useRef(controlMode);
  const activeRef = useRef(active);
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
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 14,
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: theme === "dark"
        ? { background: "#0b0d10", foreground: "#e7ebf0", cursor: "#f4f6f8", selectionBackground: "#315b7d99" }
        : { background: "#111418", foreground: "#edf1f5", cursor: "#ffffff", selectionBackground: "#3d709999" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;
    setRenderFailed(false);

    let queuedChunks: Array<{ sequence: number; frames: TerminalOutputFrame[] }> = [];
    let renderQueue: RenderBatch[] = [];
    let replayFrames: TerminalOutputFrame[] | null = null;
    let lastChunkSequence = 0;
    let animationFrame: number | null = null;
    let hiddenFlushTimer: number | null = null;
    let draining = false;
    let disposed = false;
    let releasePendingWrite: (() => void) | null = null;

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
      terminal.write(data, complete);
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
          }
          const parts = batch.reset ? [TERMINAL_RESET, ...batch.parts] : batch.parts;
          await write(mergeParts(parts, batch.bytes + (batch.reset ? TERMINAL_RESET.byteLength : 0)));
          if (disposed) return;
          stream.markRendered(sessionId, batch.sequence);
          container.dataset.renderedSequence = String(batch.sequence);
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
            replayFrames = [];
            if (frame.replayBatchEnd) appendFrame(batches, frame, true);
            continue;
          }
          if (replayFrames) {
            replayFrames.push(frame);
            if (!frame.replayBatchEnd) continue;
            const first = replayFrames[0] ?? frame;
            const combined: RenderBatch = {
              reset: true,
              cols: frame.cols || first.cols,
              rows: frame.rows || first.rows,
              sequence: Math.max(...replayFrames.map((item) => item.sequence)),
              parts: [],
              bytes: 0,
            };
            for (const replayFrame of replayFrames) {
              if (!replayFrame.data) continue;
              const bytes = decodeBase64(replayFrame.data);
              combined.parts.push(bytes);
              combined.bytes += bytes.byteLength;
            }
            batches.push(combined);
            replayFrames = null;
            continue;
          }
          appendFrame(batches, frame);
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
      if (controlModeRef.current !== "web") {
        // Scale the viewer without changing fonts or the PTY grid.
        const screen = container.querySelector<HTMLElement>(".xterm-screen");
        const width = screen?.offsetWidth ?? 0;
        const available = container.clientWidth - 28;
        if (width > 0 && available > 0) {
          const scale = Math.max(0.7, Math.min(1.4, available / width));
          const element = terminal.element;
          if (element) {
            element.style.transformOrigin = "top left";
            element.style.transform = `scale(${scale})`;
            element.style.width = `${width + 16}px`;
            element.style.height = `${Math.max(1, container.clientHeight - 12) / scale}px`;
          }
        }
        return;
      }
      if (terminal.element) {
        terminal.element.style.transform = "";
        terminal.element.style.width = "";
        terminal.element.style.height = "";
      }
      try {
        fit.fit();
        if (terminal.cols > 0 && terminal.rows > 0) resizeRef.current(terminal.cols, terminal.rows);
      } catch {
        // The container can briefly have no dimensions while mobile chrome resizes.
      }
    };
    let sizeFrame: number | null = null;
    const scheduleSize = () => {
      if (sizeFrame !== null || disposed) return;
      sizeFrame = requestAnimationFrame(() => { sizeFrame = null; if (!disposed) reportSize(); });
    };
    const input = terminal.onData((data) => inputRef.current(data));
    const render = terminal.onRender(scheduleSize);
    const scroll = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      setScrolledAway(buffer.viewportY < buffer.baseY);
    });
    const observer = new ResizeObserver(scheduleSize);
    observer.observe(container);
    const resizeFrame = requestAnimationFrame(reportSize);
    terminal.focus();

    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelAnimationFrame(resizeFrame);
      if (sizeFrame !== null) cancelAnimationFrame(sizeFrame);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (hiddenFlushTimer !== null) window.clearTimeout(hiddenFlushTimer);
      input.dispose();
      render.dispose();
      scroll.dispose();
      terminalRef.current = null;
      releasePendingWrite?.();
      releasePendingWrite = null;
      terminal.dispose();
      fitRef.current = null;
    };
  }, [sessionId, stream]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = theme === "dark"
      ? { background: "#0b0d10", foreground: "#e7ebf0", cursor: "#f4f6f8", selectionBackground: "#315b7d99" }
      : { background: "#111418", foreground: "#edf1f5", cursor: "#ffffff", selectionBackground: "#3d709999" };
  }, [theme]);

  useEffect(() => {
    if (controlMode !== "web") return;
    try {
      fitRef.current?.fit();
      const terminal = terminalRef.current;
      if (terminal && terminal.cols > 0 && terminal.rows > 0) resizeRef.current(terminal.cols, terminal.rows);
    } catch {
      // The terminal can be between layouts while ownership changes.
    }
  }, [controlMode]);

  useEffect(() => {
    if (!active) return;
    try {
      if (controlMode === "web") fitRef.current?.fit();
    } catch {
      // The active tab can still be settling into its final dimensions.
    }
    if (status === "running") terminalRef.current?.focus();
  }, [active, status, controlMode]);

  return <div className="web-terminal-shell">
    {renderFailed && <div role="alert">{errorLabel}</div>}
    <div className="web-terminal" ref={containerRef} data-status={status} />
    {active && scrolledAway && <button className="web-terminal-scroll-bottom" type="button" onClick={() => terminalRef.current?.scrollToBottom()} aria-label={scrollLabel} title={scrollLabel}><ArrowDown size={16} aria-hidden="true" /></button>}
  </div>;
}

