import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getTerminalTheme, getTerminalBackground } from "../lib/terminalThemes";

interface Props {
  sessionId: string;
  fontSize?: number;
  fontFamily?: string;
  resolvedTheme?: "dark" | "light";
  terminalThemeName?: string;
}

export function XTermTerminal({ sessionId, fontSize = 14, fontFamily = "Cascadia Code, Consolas, monospace", resolvedTheme = "dark", terminalThemeName = "auto" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);

  // Update theme when resolvedTheme or terminalThemeName changes (without recreating terminal)
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTerminalTheme(terminalThemeName, resolvedTheme);
    }
  }, [resolvedTheme, terminalThemeName]);

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

    // Forward keyboard input to PTY
    terminal.onData((data) => {
      invoke("pty_write", { sessionId, data }).catch(console.error);
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

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    // Initial resize sync
    const dims = fitAddon.proposeDimensions();
    if (dims) {
      invoke("pty_resize", { sessionId, cols: dims.cols, rows: dims.rows }).catch(console.error);
    }

    return () => {
      resizeObserver.disconnect();
      unlisten?.();
      terminal.dispose();
      terminalRef.current = null;
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
