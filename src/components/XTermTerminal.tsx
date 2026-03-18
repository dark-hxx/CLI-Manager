import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getTerminalTheme, getTerminalBackground } from "../lib/terminalThemes";
import { useCommandHistoryStore } from "../stores/commandHistoryStore";
import { useTerminalStore } from "../stores/terminalStore";

interface Props {
  sessionId: string;
  isActive?: boolean;
  fontSize?: number;
  fontFamily?: string;
  resolvedTheme?: "dark" | "light";
  terminalThemeName?: string;
}

export function XTermTerminal({ sessionId, isActive = true, fontSize = 14, fontFamily = "Cascadia Code, Consolas, monospace", resolvedTheme = "dark", terminalThemeName = "auto" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const inputBuffer = useRef("");
  const fitRafRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const lastObservedSizeRef = useRef<{ width: number; height: number } | null>(null);

  const scheduleFit = (force = false) => {
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
    }
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = null;
      const container = containerRef.current;
      const fitAddon = fitAddonRef.current;
      if (!container || !fitAddon) return;
      if (!force && (!isActiveRef.current || isComposingRef.current)) return;
      if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;
      fitAddon.fit();
    });
  };

  // Update theme when resolvedTheme or terminalThemeName changes (without recreating terminal)
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme(terminalThemeName, resolvedTheme);
    }
  }, [resolvedTheme, terminalThemeName]);

  // Refit terminal when tab becomes active
  useEffect(() => {
    isActiveRef.current = isActive;
    if (isActive && fitAddonRef.current && containerRef.current) {
      // Wait one frame to ensure display:block has taken effect and layout is stable.
      scheduleFit(true);
    }
  }, [isActive]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      cursorBlink: true,
      cursorStyle: "block",
      fontSize,
      fontFamily,
      scrollback: 1000,
      theme: getTerminalTheme(terminalThemeName, resolvedTheme),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // WebGL not supported, fall back to canvas
    }

    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

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

    terminal.attachCustomKeyEventHandler((e) => {
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
          if (text) {
            invoke("pty_write", { sessionId, data: text }).catch(console.error);
            inputBuffer.current += text;
          }
        }).catch(console.error);
        return false;
      }
      return true;
    });

    // Forward keyboard input to PTY and record command history
    const addCommand = useCommandHistoryStore.getState().addCommand;
    const getProjectId = () => useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.projectId ?? null;

    terminal.onData((data) => {
      invoke("pty_write", { sessionId, data }).catch(console.error);

      if (data === "\r") {
        const cmd = inputBuffer.current;
        if (cmd.trim()) {
          addCommand(getProjectId(), cmd);
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
      invoke("pty_resize", { sessionId, cols, rows }).catch(console.error);
    });

    // Listen for PTY output
    let unlisten: UnlistenFn | null = null;
    listen<string>(`pty-output-${sessionId}`, (event) => {
      terminal.write(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    const textarea = containerRef.current.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;

    const onCompositionStart = () => {
      isComposingRef.current = true;
    };
    const onCompositionEnd = () => {
      isComposingRef.current = false;
      scheduleFit(true);
    };

    textarea?.addEventListener("compositionstart", onCompositionStart);
    textarea?.addEventListener("compositionend", onCompositionEnd);

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

    // Initial resize sync
    const dims = fitAddon.proposeDimensions();
    if (dims) {
      invoke("pty_resize", { sessionId, cols: dims.cols, rows: dims.rows }).catch(console.error);
    }

    return () => {
      textarea?.removeEventListener("compositionstart", onCompositionStart);
      textarea?.removeEventListener("compositionend", onCompositionEnd);
      resizeObserver.disconnect();
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      unlisten?.();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, fontSize, fontFamily]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ backgroundColor: getTerminalBackground(terminalThemeName, resolvedTheme) }}
    />
  );
}
