import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useShallow } from "zustand/shallow";
import { applyTransparency, getTerminalTheme, getTerminalBackground } from "../lib/terminalThemes";
import { backgroundAssetUrl } from "../lib/assetUrl";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore, type ShellRuntimeEventName } from "../stores/terminalStore";
import { useSettingsStore, type LightThemePalette, type DarkThemePalette } from "../stores/settingsStore";

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 32;
const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 8;
const ACTIVE_WRITE_FRAME_BUDGET = 64 * 1024;
const SEARCH_HIGHLIGHT_LIMIT = 1000;
import { toast } from "sonner";
import { logError } from "../lib/logger";

interface SearchResultState {
  resultIndex: number;
  resultCount: number;
}

const EMPTY_SEARCH_RESULT: SearchResultState = { resultIndex: 0, resultCount: 0 };

const normalizeHexColor = (value: string | undefined, fallback: string) => (
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
);

const hexToRgba = (value: string | undefined, alpha: number, fallback: string) => {
  const normalized = normalizeHexColor(value, "");
  if (!normalized) return fallback;
  const hex = normalized.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

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
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchMatched, setSearchMatched] = useState<boolean | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResultState>(EMPTY_SEARCH_RESULT);

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

  useEffect(() => {
    if (!searchOpen) return;
    const rafId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [searchOpen]);

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
      scrollOnEraseInDisplay: true,
      allowProposedApi: true,
      windowsPty: { backend: "conpty" },
      // Always true — research confirms WebglAddon stays compatible and the
      // perf cost is acceptable. xterm cannot toggle this after construction,
      // so we pay it unconditionally to avoid having to recreate the terminal
      // when the user enables/disables the background image.
      allowTransparency: true,
      theme: isTransparentRef.current ? applyTransparency(baseTheme, background.overlayDarken) : baseTheme,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(containerRef.current);
    const searchResultDisposable = searchAddon.onDidChangeResults((event) => {
      setSearchResult({ resultIndex: event.resultIndex, resultCount: event.resultCount });
    });

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
    searchAddonRef.current = searchAddon;
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

    const markAttentionInputHandled = () => useTerminalStore.getState().markAttentionInputHandled(sessionId);

    const pasteIntoTerminal = (text: string) => {
      if (!text) return;
      markAttentionInputHandled();
      terminal.paste(text);
    };

    const pasteTarget = containerRef.current;
    const pasteListenerOptions = { capture: true } as const;
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      pasteIntoTerminal(text);
    };

    pasteTarget.addEventListener("paste", onPaste, pasteListenerOptions);

    const isCodexNewlineSession = () => {
      const session = useTerminalStore.getState().sessions.find((item) => item.id === sessionId);
      const project = session?.projectId
        ? useProjectStore.getState().projects.find((item) => item.id === session.projectId)
        : null;
      if (project?.cli_tool.trim().toLowerCase() === "codex") return true;
      const startupCmd = session?.startupCmd?.toLowerCase() ?? "";
      const titleTool = session?.title.match(/\(([^()]*)\)\s*$/)?.[1]?.trim().toLowerCase() ?? "";
      return titleTool === "codex" || /(?:^|\s)codex(?:\s|$)/.test(startupCmd);
    };

    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter") {
        const shortcut = useSettingsStore.getState().terminalNewlineShortcut;
        const managedCombo =
          (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) ||
          (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) ||
          (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey);
        const matched =
          (shortcut === "Shift+Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) ||
          (shortcut === "Ctrl+Enter" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) ||
          (shortcut === "Alt+Enter" && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey);
        if (managedCombo) {
          e.preventDefault();
          if (matched) {
            markAttentionInputHandled();
            const newlineData = isCodexNewlineSession() ? "\x1b\r" : "\n";
            invoke("pty_write", { sessionId, data: newlineData }).catch((err) => reportPtyWriteError("newline", err));
          }
          return false;
        }
      }
      if (e.type !== "keydown" || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
        return false;
      }
      if (key === "c" && terminal.hasSelection()) {
        e.preventDefault();
        void copySelection();
        terminal.clearSelection();
        return false;
      }
      if (key === "v") {
        e.preventDefault();
        navigator.clipboard.readText().then((text) => {
          pasteIntoTerminal(text);
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
      } else if (data.length > 1) {
        const pastedText = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
        if (!pastedText.startsWith("\x1b")) {
          inputBuffer.current += pastedText.replace(/\r\n?/g, "\n");
        }
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

    const terminalContainer = containerRef.current;
    const textarea = terminalContainer.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
    const viewport = terminalContainer.querySelector(".xterm-viewport") as HTMLElement | null;
    let compositionScrollRafId: number | null = null;
    let containerScrollResetRafId: number | null = null;
    let helperTextareaAnchorRafId: number | null = null;
    let compositionScrollLock: { element: HTMLElement; scrollTop: number; scrollLeft: number }[] = [];

    const captureCompositionScroll = () => {
      compositionScrollLock = [terminalContainer, viewport]
        .filter((element): element is HTMLElement => Boolean(element))
        .map((element) => ({
          element,
          scrollTop: element.scrollTop,
          scrollLeft: element.scrollLeft,
        }));
    };

    const restoreCompositionScroll = () => {
      for (const { element, scrollTop, scrollLeft } of compositionScrollLock) {
        if (element.scrollTop !== scrollTop) element.scrollTop = scrollTop;
        if (element.scrollLeft !== scrollLeft) element.scrollLeft = scrollLeft;
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

    const resetTerminalContainerScroll = () => {
      if (terminalContainer.scrollTop !== 0) terminalContainer.scrollTop = 0;
      if (terminalContainer.scrollLeft !== 0) terminalContainer.scrollLeft = 0;
    };

    const scheduleTerminalContainerScrollReset = () => {
      resetTerminalContainerScroll();
      if (containerScrollResetRafId !== null) {
        cancelAnimationFrame(containerScrollResetRafId);
      }
      containerScrollResetRafId = requestAnimationFrame(() => {
        containerScrollResetRafId = null;
        resetTerminalContainerScroll();
      });
    };

    const pinHelperTextareaAnchor = () => {
      if (!textarea || isComposingRef.current) return;
      textarea.style.left = "-9999em";
      textarea.style.top = "0px";
      textarea.style.width = "0px";
      textarea.style.height = "0px";
      textarea.style.lineHeight = "";
    };

    const scheduleHelperTextareaAnchorPin = () => {
      pinHelperTextareaAnchor();
      if (helperTextareaAnchorRafId !== null) {
        cancelAnimationFrame(helperTextareaAnchorRafId);
      }
      helperTextareaAnchorRafId = requestAnimationFrame(() => {
        helperTextareaAnchorRafId = null;
        pinHelperTextareaAnchor();
      });
    };

    const releaseHelperTextareaAnchorPin = () => {
      if (helperTextareaAnchorRafId !== null) {
        cancelAnimationFrame(helperTextareaAnchorRafId);
        helperTextareaAnchorRafId = null;
      }
      if (!textarea) return;
      textarea.style.left = "";
      textarea.style.top = "";
      textarea.style.width = "";
      textarea.style.height = "";
      textarea.style.lineHeight = "";
    };

    scheduleHelperTextareaAnchorPin();
    terminalContainer.addEventListener("scroll", scheduleTerminalContainerScrollReset, { passive: true });
    const cursorMoveDisposable = terminal.onCursorMove(() => {
      if (!isActiveRef.current || isComposingRef.current) return;
      if (!textarea || document.activeElement !== textarea) return;
      scheduleTerminalContainerScrollReset();
      scheduleHelperTextareaAnchorPin();
    });

    const onCompositionStart = () => {
      isComposingRef.current = true;
      releaseHelperTextareaAnchorPin();
      captureCompositionScroll();
      scheduleCompositionScrollRestore();
    };
    const onCompositionUpdate = () => {
      scheduleCompositionScrollRestore();
    };
    const onCompositionEnd = () => {
      isComposingRef.current = false;
      scheduleCompositionScrollRestore();
      scheduleHelperTextareaAnchorPin();
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
      terminalContainer.removeEventListener("scroll", scheduleTerminalContainerScrollReset);
      cursorMoveDisposable.dispose();
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
      if (containerScrollResetRafId !== null) {
        cancelAnimationFrame(containerScrollResetRafId);
        containerScrollResetRafId = null;
      }
      if (helperTextareaAnchorRafId !== null) {
        cancelAnimationFrame(helperTextareaAnchorRafId);
        helperTextareaAnchorRafId = null;
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
      searchResultDisposable.dispose();
      webglAddon?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [sessionId]);

  const backgroundColor = getTerminalBackground(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);

  const showBackgroundImage = isTransparent && assetUrl !== null;
  const terminalTheme = getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette);
  const searchForeground = normalizeHexColor(terminalTheme.foreground, "#d8dee9");
  const searchBackground = normalizeHexColor(terminalTheme.background, backgroundColor);
  const searchAccent = normalizeHexColor(terminalTheme.cursor, searchForeground);
  const searchMatchBackground = normalizeHexColor(terminalTheme.yellow, "#e0af68");
  const searchActiveBackground = normalizeHexColor(terminalTheme.blue, "#7aa2f7");
  const searchResultLabel = !searchTerm
    ? ""
    : searchResult.resultCount > 0 && searchResult.resultIndex >= 0
      ? `${searchResult.resultIndex + 1}/${searchResult.resultCount}`
      : searchMatched === false
        ? "0/0"
        : "";

  const terminalSearchShellStyle: CSSProperties = {
    position: "absolute",
    right: 12,
    top: 12,
    zIndex: 20,
    backgroundColor: hexToRgba(searchBackground, showBackgroundImage ? 0.78 : 0.92, "rgba(0, 0, 0, 0.86)"),
    borderColor: hexToRgba(searchForeground, 0.24, "rgba(255, 255, 255, 0.22)"),
    boxShadow: `0 12px 30px ${hexToRgba(searchBackground, 0.55, "rgba(0, 0, 0, 0.45)")}`,
    color: searchForeground,
    fontFamily,
    maxWidth: "min(440px, calc(100% - 24px))",
  };
  const terminalSearchInputStyle: CSSProperties = {
    caretColor: searchAccent,
    color: searchForeground,
  };
  const terminalSearchButtonStyle: CSSProperties = {
    backgroundColor: hexToRgba(searchForeground, 0.08, "rgba(255, 255, 255, 0.08)"),
    borderColor: hexToRgba(searchForeground, 0.16, "rgba(255, 255, 255, 0.16)"),
    color: searchForeground,
  };

  const createSearchOptions = (incremental = false): ISearchOptions => ({
    incremental,
    decorations: {
      matchBackground: searchMatchBackground,
      matchBorder: searchMatchBackground,
      matchOverviewRuler: searchMatchBackground,
      activeMatchBackground: searchActiveBackground,
      activeMatchBorder: searchAccent,
      activeMatchColorOverviewRuler: searchAccent,
    },
  });

  const clearTerminalSearch = () => {
    searchAddonRef.current?.clearDecorations();
    setSearchMatched(null);
    setSearchResult(EMPTY_SEARCH_RESULT);
  };

  const runTerminalSearch = (term: string, direction: "next" | "previous", incremental = false) => {
    const searchAddon = searchAddonRef.current;
    if (!term || !searchAddon) {
      clearTerminalSearch();
      return;
    }
    const matched = direction === "previous"
      ? searchAddon.findPrevious(term, createSearchOptions(false))
      : searchAddon.findNext(term, createSearchOptions(incremental));
    setSearchMatched(matched);
  };

  const handleSearchTermChange = (value: string) => {
    setSearchTerm(value);
    runTerminalSearch(value, "next", true);
  };

  const closeTerminalSearch = () => {
    setSearchOpen(false);
    setSearchTerm("");
    clearTerminalSearch();
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  };

  // When the background image is active, an opaque wrapper background would
  // cover the pseudo-element image layer and break the transparency model.
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
      className="ui-terminal-bg-layer relative h-full w-full overflow-hidden"
      style={wrapperStyle}
      data-bg-enabled={showBackgroundImage ? "true" : undefined}
      data-bg-fit={showBackgroundImage ? background.fit : undefined}
      data-bg-position={showBackgroundImage ? background.position : undefined}
    >
      {searchOpen && (
        <div
          className="absolute right-3 top-3 z-20 flex h-8 items-center gap-1 rounded-md border px-2 text-[12px] backdrop-blur-md"
          style={terminalSearchShellStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="select-none font-mono text-[13px] opacity-70" aria-hidden="true">/</span>
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => handleSearchTermChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                runTerminalSearch(searchTerm, e.shiftKey ? "previous" : "next");
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                runTerminalSearch(searchTerm, "next");
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                runTerminalSearch(searchTerm, "previous");
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeTerminalSearch();
              }
            }}
            className="h-6 w-44 min-w-0 bg-transparent px-1 font-mono text-[12px] outline-none placeholder:opacity-55"
            style={terminalSearchInputStyle}
            placeholder="search"
            aria-label="搜索终端输出"
          />
          <span className="w-12 select-none text-right font-mono text-[11px] opacity-70" aria-live="polite">
            {searchResultLabel}
          </span>
          <button
            type="button"
            disabled={!searchTerm}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTerminalSearch(searchTerm, "previous")}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none disabled:opacity-35"
            style={terminalSearchButtonStyle}
            aria-label="上一个匹配"
            title="上一个匹配"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={!searchTerm}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTerminalSearch(searchTerm, "next")}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none disabled:opacity-35"
            style={terminalSearchButtonStyle}
            aria-label="下一个匹配"
            title="下一个匹配"
          >
            ↓
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeTerminalSearch}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none"
            style={terminalSearchButtonStyle}
            aria-label="关闭搜索"
            title="关闭搜索"
          >
            x
          </button>
        </div>
      )}
      <div ref={containerRef} className="h-full w-full overflow-hidden pl-2" />
    </div>
  );
}
