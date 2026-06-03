import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useShallow } from "zustand/shallow";
import { applyTransparency, getTerminalTheme, getTerminalBackground } from "../lib/terminalThemes";
import { backgroundAssetUrl } from "../lib/assetUrl";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useTerminalStore, type ShellRuntimeEventName } from "../stores/terminalStore";
import { useSettingsStore, type LightThemePalette, type DarkThemePalette } from "../stores/settingsStore";

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 8;
const ACTIVE_WRITE_FRAME_BUDGET = 64 * 1024;
import { toast } from "sonner";
import { logError } from "../lib/logger";

interface Props {
  sessionId: string;
  isActive?: boolean;
  fontSize?: number;
  fontFamily?: string;
  resolvedTheme?: "dark" | "light";
  terminalThemeName?: string;
  lightThemePalette?: LightThemePalette;
  darkThemePalette?: DarkThemePalette;
}

export function XTermTerminal({ sessionId, isActive = true, fontSize = 14, fontFamily = "Cascadia Code, Consolas, monospace", resolvedTheme = "dark", terminalThemeName = "auto", lightThemePalette = "warm-paper", darkThemePalette = "night-indigo" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputBuffer = useRef("");
  const fitRafRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const lastObservedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const inactiveBufferRef = useRef<string[]>([]);
  const inactiveBufferSizeRef = useRef(0);
  const activeWriteQueueRef = useRef<string[]>([]);
  const activeWriteRafRef = useRef<number | null>(null);
  const cursorShowTimerRef = useRef<number | null>(null);
  const INACTIVE_BUFFER_MAX = 256 * 1024;
  const runtimeOscBufferRef = useRef("");

  const background = useSettingsStore(
    useShallow((s) => ({
      enabled: s.terminalBackground.enabled,
      imagePath: s.terminalBackground.imagePath,
      opacity: s.terminalBackground.opacity,
      fit: s.terminalBackground.fit,
      position: s.terminalBackground.position,
      blur: s.terminalBackground.blur,
      overlayDarken: s.terminalBackground.overlayDarken,
    }))
  );
  const hiddenForThisSession = useTerminalStore((s) => s.hiddenBackgroundSessionIds.has(sessionId));

  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!background.imagePath) {
      setAssetUrl(null);
      return;
    }
    backgroundAssetUrl(background.imagePath).then((url) => {
      if (!cancelled) setAssetUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [background.imagePath]);

  const isTransparent = background.enabled && background.imagePath !== null && !hiddenForThisSession;
  const isTransparentRef = useRef(isTransparent);
  isTransparentRef.current = isTransparent;

  const fitWhenStable = (force = false) => {
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    if (!container || !fitAddon) return;
    if (!force && (!isActiveRef.current || isComposingRef.current)) return;
    if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;

    const dims = fitAddon.proposeDimensions();
    if (!dims || dims.cols < MIN_TERMINAL_COLS || dims.rows < MIN_TERMINAL_ROWS) return;
    fitAddon.fit();
  };

  const scheduleFit = (force = false) => {
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
    }
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = requestAnimationFrame(() => {
        fitRafRef.current = null;
        fitWhenStable(force);
      });
    });
  };

  const reportPtyWriteError = (stage: string, err: unknown) => {
    toast.error("终端写入失败", { description: String(err) });
    logError("PTY write failed in XTermTerminal", { sessionId, stage, err });
  };

  const cancelPendingCursorShow = () => {
    if (cursorShowTimerRef.current !== null) {
      window.clearTimeout(cursorShowTimerRef.current);
      cursorShowTimerRef.current = null;
    }
  };

  const scheduleCursorShow = () => {
    cancelPendingCursorShow();
    cursorShowTimerRef.current = window.setTimeout(() => {
      cursorShowTimerRef.current = null;
      terminalRef.current?.write("\x1b[?25h");
    }, 80);
  };

  const handleShellRuntimeOsc = (marker: string) => {
    const body = marker.slice("\x1b]777;cli-manager;".length, -1);
    const fields = Object.fromEntries(body.split(";").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
    }));
    if (fields.session !== sessionId) return;
    const eventName = fields.event;
    if (eventName !== "command_started" && eventName !== "command_finished" && eventName !== "prompt_shown") return;
    const exitCode = fields.exit !== undefined && fields.exit !== "" ? Number(fields.exit) : null;
    useTerminalStore.getState().handleShellRuntimeEvent({
      sessionId,
      event: eventName as ShellRuntimeEventName,
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
    });
  };

  const stripShellRuntimeOsc = (text: string) => {
    const combined = runtimeOscBufferRef.current + text;
    runtimeOscBufferRef.current = "";
    let output = "";
    let cursor = 0;

    while (cursor < combined.length) {
      const start = combined.indexOf("\x1b]777;cli-manager;", cursor);
      if (start < 0) {
        output += combined.slice(cursor);
        break;
      }

      output += combined.slice(cursor, start);
      const end = combined.indexOf("\x07", start);
      if (end < 0) {
        runtimeOscBufferRef.current = combined.slice(start);
        break;
      }

      handleShellRuntimeOsc(combined.slice(start, end + 1));
      cursor = end + 1;
    }

    if (runtimeOscBufferRef.current.length > 8192) {
      runtimeOscBufferRef.current = "";
    }

    return output;
  };

  const processCursorVisibility = (text: string) => {
    const cursorPattern = /\x1b\[\?25[hl]/g;
    let processed = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = cursorPattern.exec(text)) !== null) {
      processed += text.slice(lastIndex, match.index);
      const sequence = match[0];
      if (sequence.endsWith("l")) {
        cancelPendingCursorShow();
        processed += sequence;
      } else {
        scheduleCursorShow();
      }
      lastIndex = match.index + sequence.length;
    }

    return processed + text.slice(lastIndex);
  };

  const flushActiveWriteQueue = () => {
    activeWriteRafRef.current = null;
    if (!isActiveRef.current || activeWriteQueueRef.current.length === 0) return;
    const terminal = terminalRef.current;
    if (!terminal) return;

    let budget = ACTIVE_WRITE_FRAME_BUDGET;
    while (budget > 0 && activeWriteQueueRef.current.length > 0) {
      const chunk = activeWriteQueueRef.current[0];
      if (chunk.length <= budget) {
        terminal.write(chunk);
        activeWriteQueueRef.current.shift();
        budget -= chunk.length;
        continue;
      }
      terminal.write(chunk.slice(0, budget));
      activeWriteQueueRef.current[0] = chunk.slice(budget);
      budget = 0;
    }

    if (activeWriteQueueRef.current.length > 0) {
      activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
    }
  };

  const enqueueActiveWrite = (text: string) => {
    if (!text) return;
    activeWriteQueueRef.current.push(processCursorVisibility(text));
    if (activeWriteRafRef.current === null) {
      activeWriteRafRef.current = requestAnimationFrame(flushActiveWriteQueue);
    }
  };

  // Hot-update theme / fontSize / fontFamily without recreating the terminal.
  // `isTransparent` is in the dep array so toggling the background image
  // immediately recomputes the theme (otherwise the WebGL clear color stays
  // opaque and the image-bearing pseudo-elements get painted over).
  // `background.overlayDarken` is also tracked so the per-cell alpha floor
  // (which stabilises subpixel text edges over high-frequency images) updates
  // live while the user drags the slider.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const baseTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    terminal.options.theme = isTransparent ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme;
    const sizeChanged = terminal.options.fontSize !== fontSize || terminal.options.fontFamily !== fontFamily;
    if (sizeChanged) {
      terminal.options.fontSize = fontSize;
      terminal.options.fontFamily = fontFamily;
      scheduleFit(true);
    }
  }, [fontSize, fontFamily, resolvedTheme, terminalThemeName, lightThemePalette, darkThemePalette, isTransparent, background.overlayDarken]);

  // Refit terminal when tab becomes active
  useEffect(() => {
    const wasActive = isActiveRef.current;
    isActiveRef.current = isActive;
    if (terminalRef.current) {
      if (!isActive) {
        terminalRef.current.blur();
      }
    }
    if (isActive && fitAddonRef.current && containerRef.current) {
      // Flush data stashed while this tab was hidden
      if (!wasActive && inactiveBufferRef.current.length > 0 && terminalRef.current) {
        const combined = inactiveBufferRef.current.join("");
        inactiveBufferRef.current = [];
        inactiveBufferSizeRef.current = 0;
        enqueueActiveWrite(combined);
      }
      // Wait one frame to ensure display:block has taken effect and layout is stable.
      scheduleFit(true);
      terminalRef.current?.focus();
    }
  }, [isActive]);

  useEffect(() => {
    if (!containerRef.current) return;

    const baseTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      cursorBlink: false,
      cursorStyle: "block",
      fontSize,
      fontFamily,
      scrollback: 5000,
      // Always true — research confirms WebglAddon stays compatible and the
      // perf cost is acceptable. xterm cannot toggle this after construction,
      // so we pay it unconditionally to avoid having to recreate the terminal
      // when the user enables/disables the background image.
      allowTransparency: true,
      theme: isTransparentRef.current ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      // GPU 上下文丢失（驱动崩溃 / GPU 进程重启 / 长会话）后 WebGL 渲染会僵死。
      // 注册 contextLoss 回调，丢失时 dispose 让 xterm 自动回落到 Canvas 渲染器。
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = null;
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not supported, fall back to canvas
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    scheduleFit(true);
    if (isActive) {
      terminal.focus();
    }

    const copySelection = async () => {
      const selection = terminal.getSelection();
      if (!selection) return;
      try {
        await navigator.clipboard.writeText(selection);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = selection;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(textarea);
        }
      }
    };

    const normalizePastedInput = (text: string) => text.replace(/\r\n?/g, "\n");

    const markAttentionInputHandled = () => useTerminalStore.getState().markAttentionInputHandled(sessionId);

    const writePastedInput = (text: string) => {
      const data = normalizePastedInput(text);
      if (!data) return;
      markAttentionInputHandled();
      inputBuffer.current += data;
      invoke("pty_write", { sessionId, data }).catch((err) => reportPtyWriteError("paste", err));
    };

    const pasteTarget = containerRef.current;
    const pasteListenerOptions = { capture: true } as const;
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      writePastedInput(text);
    };

    pasteTarget.addEventListener("paste", onPaste, pasteListenerOptions);

    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter") {
        const shortcut = useSettingsStore.getState().terminalNewlineShortcut;
        const matched =
          (shortcut === "Shift+Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) ||
          (shortcut === "Ctrl+Enter" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) ||
          (shortcut === "Alt+Enter" && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey);
        if (matched) {
          e.preventDefault();
          markAttentionInputHandled();
          invoke("pty_write", { sessionId, data: "\n" }).catch((err) => reportPtyWriteError("newline", err));
          return false;
        }
      }
      if (e.type !== "keydown" || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) {
        e.preventDefault();
        void copySelection();
        terminal.clearSelection();
        return false;
      }
      if (key === "v") {
        e.preventDefault();
        navigator.clipboard.readText().then((text) => {
          writePastedInput(text);
        }).catch((err) => {
          logError("Failed to read clipboard text", { sessionId, err });
        });
        return false;
      }
      return true;
    });

    // Forward keyboard input to PTY and record command history
    const addCommand = useCommandHistoryStore.getState().addCommand;
    const getProjectId = () => useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.projectId ?? null;

    terminal.onData((data) => {
      markAttentionInputHandled();
      invoke("pty_write", { sessionId, data }).catch((err) => reportPtyWriteError("onData", err));

      if (data === "\r") {
        const cmd = inputBuffer.current;
        if (cmd.trim()) {
          addCommand(getProjectId(), cmd);
          useTerminalStore.getState().handleShellRuntimeEvent({ sessionId, event: "command_started" });
        }
        inputBuffer.current = "";
      } else if (data === "\x7f" || data === "\b") {
        inputBuffer.current = inputBuffer.current.slice(0, -1);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputBuffer.current += data;
      } else if (data.length > 1 && !data.startsWith("\x1b")) {
        // Pasted text
        inputBuffer.current += data;
      }
    });

    // Sync resize to PTY
    terminal.onResize(({ cols, rows }) => {
      if (cols < MIN_TERMINAL_COLS || rows < MIN_TERMINAL_ROWS) return;
      invoke("pty_resize", { sessionId, cols, rows }).catch((err) => {
        logError("PTY resize failed in XTermTerminal", { sessionId, cols, rows, err });
      });
    });

    // Per-session TextDecoder with stream mode：
    // 跨 chunk 的多字节 UTF-8 必须使用 streaming decode，否则截断的 head/tail
    // 字节会被解码为 U+FFFD + 残字节，残字节进入 xterm 后会污染 SGR 解析状态
    // （表现为背景色串列、左侧异常红色竖条）。后端虽已保证字节边界对齐
    // （src-tauri/src/pty/boundary.rs），前端 stream 模式作为双重防御。
    // 不使用模块级共享 decoder：stream 模式会保留状态，跨会话共享会导致污染。
    const textDecoder = new TextDecoder("utf-8");

    // Listen for PTY output (Base64 encoded to preserve control characters)
    // Batch chunks per animation frame to keep main thread responsive on high-throughput output.
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    let pendingChunks: string[] = [];
    let writeRafId: number | null = null;
    const stashInactiveText = (text: string) => {
      if (!text) return;
      if (text.length >= INACTIVE_BUFFER_MAX) {
        const suffix = text.slice(-INACTIVE_BUFFER_MAX);
        inactiveBufferRef.current = [suffix];
        inactiveBufferSizeRef.current = suffix.length;
        return;
      }

      inactiveBufferRef.current.push(text);
      inactiveBufferSizeRef.current += text.length;
      while (inactiveBufferSizeRef.current > INACTIVE_BUFFER_MAX && inactiveBufferRef.current.length > 0) {
        const overflow = inactiveBufferSizeRef.current - INACTIVE_BUFFER_MAX;
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
    const flushPendingWrites = () => {
      writeRafId = null;
      if (cancelled || pendingChunks.length === 0) return;
      const combined = pendingChunks.length === 1 ? pendingChunks[0] : pendingChunks.join("");
      pendingChunks = [];
      if (isActiveRef.current) {
        enqueueActiveWrite(combined);
      } else {
        stashInactiveText(combined);
      }
    };
    listen<string>(`pty-output-${sessionId}`, (event) => {
      if (cancelled) return;
      const binaryString = atob(event.payload);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i += 1) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const text = stripShellRuntimeOsc(textDecoder.decode(bytes, { stream: true }));
      if (!text) return;
      if (isActiveRef.current) {
        pendingChunks.push(text);
        if (writeRafId === null) {
          writeRafId = requestAnimationFrame(flushPendingWrites);
        }
      } else {
        // Tab hidden — stash to a bounded ring buffer; flush when reactivated
        stashInactiveText(text);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    const textarea = containerRef.current.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    const viewport = containerRef.current.querySelector(".xterm-viewport") as HTMLElement | null;
    let compositionScrollRafId: number | null = null;
    let compositionScrollLock: { element: HTMLElement; scrollTop: number; scrollLeft: number }[] = [];

    const captureCompositionScroll = () => {
      const container = containerRef.current;
      compositionScrollLock = [container, viewport]
        .filter((element): element is HTMLElement => Boolean(element))
        .map((element) => ({
          element,
          scrollTop: element.scrollTop,
          scrollLeft: element.scrollLeft,
        }));
    };

    const restoreCompositionScroll = () => {
      for (const { element, scrollTop, scrollLeft } of compositionScrollLock) {
        element.scrollTop = scrollTop;
        element.scrollLeft = scrollLeft;
      }
    };

    const scheduleCompositionScrollRestore = () => {
      restoreCompositionScroll();
      if (compositionScrollRafId !== null) {
        cancelAnimationFrame(compositionScrollRafId);
      }
      compositionScrollRafId = requestAnimationFrame(() => {
        compositionScrollRafId = null;
        restoreCompositionScroll();
      });
    };

    const onCompositionStart = () => {
      isComposingRef.current = true;
      captureCompositionScroll();
      scheduleCompositionScrollRestore();
    };
    const onCompositionUpdate = () => {
      scheduleCompositionScrollRestore();
    };
    const onCompositionEnd = () => {
      isComposingRef.current = false;
      scheduleCompositionScrollRestore();
      scheduleFit(true);
    };

    textarea?.addEventListener("compositionstart", onCompositionStart);
    textarea?.addEventListener("compositionupdate", onCompositionUpdate);
    textarea?.addEventListener("compositionend", onCompositionEnd);

    // Ctrl + wheel adjusts global font size (writes settings store, like Windows Terminal but persistent).
    const wheelTarget = containerRef.current;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const current = useSettingsStore.getState().fontSize;
      const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + (e.deltaY > 0 ? -1 : 1)));
      if (next !== current) {
        void useSettingsStore.getState().update("fontSize", next);
      }
    };
    wheelTarget.addEventListener("wheel", onWheel, { passive: false, capture: true });

    // Resize observer — skip fit when container is hidden or IME composition is active.
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
    resizeObserver.observe(containerRef.current);


    return () => {
      cancelled = true;
      cancelPendingCursorShow();
      pasteTarget.removeEventListener("paste", onPaste, pasteListenerOptions);
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionupdate", onCompositionUpdate);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      wheelTarget.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      resizeObserver.disconnect();
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      if (compositionScrollRafId !== null) {
        cancelAnimationFrame(compositionScrollRafId);
        compositionScrollRafId = null;
      }
      if (writeRafId !== null) {
        cancelAnimationFrame(writeRafId);
        writeRafId = null;
      }
      if (activeWriteRafRef.current !== null) {
        cancelAnimationFrame(activeWriteRafRef.current);
        activeWriteRafRef.current = null;
      }
      pendingChunks = [];
      activeWriteQueueRef.current = [];
      inactiveBufferRef.current = [];
      inactiveBufferSizeRef.current = 0;
      unlisten?.();
      webglAddon?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  const backgroundColor = getTerminalBackground(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);

  const showBackgroundImage = isTransparent && assetUrl !== null;
  // When the background image is active, we MUST NOT set `backgroundColor` on
  // the wrapper: the `::before` pseudo-element paints the image into the same
  // rect, and an opaque wrapper background would either dim the image (when
  // user opacity < 100%) or render the whole transparency model meaningless.
  // Also drop `p-2` in this mode — the padding gap exposes the image around
  // the xterm container (the user-visible "strip" bug). Without an image we
  // keep the original opaque background + padding behavior unchanged.
  const wrapperStyle: CSSProperties = showBackgroundImage
    ? ({
        "--terminal-bg-image": `url("${assetUrl}")`,
        "--terminal-bg-opacity": (background.opacity / 100).toString(),
        "--terminal-bg-blur": `${background.blur}px`,
        "--terminal-bg-darken": (background.overlayDarken / 100).toString(),
      } as CSSProperties)
    : { backgroundColor };

  return (
    <div
      className={`ui-terminal-bg-layer h-full w-full overflow-hidden${showBackgroundImage ? "" : " p-2"}`}
      style={wrapperStyle}
      data-bg-enabled={showBackgroundImage ? "true" : undefined}
      data-bg-fit={showBackgroundImage ? background.fit : undefined}
      data-bg-position={showBackgroundImage ? background.position : undefined}
    >
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}
